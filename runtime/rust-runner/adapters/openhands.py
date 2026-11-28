"""Run one managed OpenHands conversation and stream its events to Open Harness."""

import json
import os
import sys
from pathlib import Path
from tempfile import TemporaryDirectory


CONFIG = Path("/run/open-harness/config.json")
WORKSPACE = "/workspace"
EDITOR_GRANTS = {"read_file", "write_file", "patch"}
PROVIDERS = {
    "openai": "openai",
    "anthropic": "anthropic",
    "xai": "xai",
    "openrouter": "openrouter",
    "local": "openai",
    "custom": "openai",
}


def model_options(config, key):
    provider = config["provider"]
    prefix = PROVIDERS.get(provider)
    if prefix is None:
        raise ValueError("Choose a supported OpenHands model provider.")

    base_url = config["baseUrl"].rstrip("/")
    compatible = provider in {"local", "custom"}
    if compatible and not base_url:
        raise ValueError("Enter an OpenAI-compatible endpoint for OpenHands.")
    if not compatible and not key:
        raise ValueError("Save a model credential for this OpenHands agent.")
    if provider == "anthropic" and base_url:
        # LiteLLM accepts a complete Anthropic Messages endpoint.
        if not base_url.endswith("/v1/messages"):
            base_url = base_url.removesuffix("/v1") + "/v1/messages"

    return {
        "model": f"{prefix}/{config['model']}",
        "base_url": base_url or None,
        # The OpenAI client needs a nonempty key even for unauthenticated servers.
        "api_key": key or "open-harness-local",
        "api_mode": "chat" if compatible else "auto",
        "log_completions_to_file": False,
    }


def message_text(message, text_content):
    return "".join(part.text for part in message.content if isinstance(part, text_content))


def run(config, prompt, key, emit):
    from openhands.sdk import Agent, AgentContext, Conversation, ConversationExecutionStatus
    from openhands.sdk import LLM, TextContent, Tool
    from openhands.sdk.event import ActionEvent, MessageEvent, ObservationEvent
    from openhands.sdk.event.llm_convertible.observation import ObservationBaseEvent
    from openhands.sdk.security.confirmation_policy import NeverConfirm
    from openhands.sdk.tool.builtins.finish import FinishAction, FinishTool
    from openhands.tools.file_editor import FileEditorTool
    from openhands.tools.terminal import TerminalTool

    grants = set(config["tools"])
    editor_grants = grants & EDITOR_GRANTS
    if editor_grants and editor_grants != EDITOR_GRANTS:
        raise ValueError("OpenHands requires read, write, and edit permissions together.")

    tools = []
    if "terminal" in grants:
        tools.append(Tool(name=TerminalTool.name, params={"terminal_type": "subprocess"}))
    if editor_grants:
        tools.append(Tool(name=FileEditorTool.name))
    visible_tools = {tool.name for tool in tools}

    instructions = (
        "Use /workspace/shared for shared project files and /workspace/private for "
        "your private files. Extra folders, when granted, are under /workspace/mounts."
    )
    if config["instructions"]:
        instructions += "\n\n" + config["instructions"]

    agent = Agent(
        llm=LLM(**model_options(config, key)),
        tools=tools,
        include_default_tools=[FinishTool.__name__],
        mcp_config={},
        agent_context=AgentContext(
            system_message_suffix=instructions,
            load_user_skills=False,
            load_public_skills=False,
            load_project_skills=False,
            load_memory=False,
        ),
    )

    latest_reply = ""
    finish_reply = ""

    def on_event(event):
        nonlocal latest_reply, finish_reply
        if isinstance(event, MessageEvent) and event.source == "agent":
            text = message_text(event.llm_message, TextContent)
            if text:
                latest_reply = text
                emit("message", text=text)
        elif isinstance(event, ActionEvent):
            if isinstance(event.action, FinishAction):
                finish_reply = event.action.message
            elif event.tool_name in visible_tools:
                preview = event.action.model_dump_json(exclude_none=True) if event.action else ""
                emit("tool.start", id=event.tool_call_id, name=event.tool_name, preview=preview)
        elif isinstance(event, ObservationBaseEvent) and event.tool_name in visible_tools:
            failed = not isinstance(event, ObservationEvent) or event.observation.is_error
            emit(
                "tool.complete",
                id=event.tool_call_id,
                name=event.tool_name,
                result=message_text(event.to_llm_message(), TextContent),
                error=failed,
            )

    # SDK plugin discovery starts at this root. Only its children are mounted.
    conversation = Conversation(
        agent=agent, workspace=WORKSPACE, callbacks=[on_event], visualizer=None
    )
    try:
        conversation.set_confirmation_policy(NeverConfirm())
        conversation.send_message(prompt)
        conversation.run()
        status = conversation.state.execution_status
        if status != ConversationExecutionStatus.FINISHED:
            raise RuntimeError(f"OpenHands stopped with status {status.value} before completing.")
    finally:
        conversation.close()

    if finish_reply and finish_reply != latest_reply:
        emit("message", text=finish_reply)
    return finish_reply or latest_reply


def main():
    # Keep SDK and shell output on stderr, including writes made to descriptor 1.
    with os.fdopen(os.dup(sys.stdout.fileno()), "w", encoding="utf-8") as protocol:
        os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
        key = os.environ.pop("OPEN_HARNESS_MODEL_API_KEY", "")
        escaped_key = json.dumps(key, ensure_ascii=False)[1:-1]
        limits = {"preview": 1000, "result": 4000, "message": 1000, "text": 200_000}

        def emit(event_type, **fields):
            for name, value in fields.items():
                if isinstance(value, str):
                    if key:
                        if escaped_key != key:
                            value = value.replace(escaped_key, "[redacted]")
                        value = value.replace(key, "[redacted]")
                    fields[name] = value[:limits.get(name, 1000)]
            print(json.dumps({"type": event_type, **fields}), file=protocol, flush=True)

        try:
            config = json.loads(CONFIG.read_text(encoding="utf-8"))
            prompt = sys.stdin.buffer.read().decode("utf-8")
            # Ambient user plugins and profiles must come from an empty home.
            with TemporaryDirectory(prefix="openhands-") as home:
                os.environ["HOME"] = home
                os.environ["OH_PERSISTENCE_DIR"] = home
                os.environ["LITELLM_LOCAL_MODEL_COST_MAP"] = "True"
                result = run(config, prompt, key, emit)
            emit("result", text=result)
            return 0
        except Exception as error:
            emit("error", message=str(error).strip() or type(error).__name__)
            return 1


if __name__ == "__main__":
    sys.exit(main())
