import type { Message, RunEvent } from './types';

// One event page can contain hundreds of token deltas. Fold it before updating the
// workspace so each token doesn't copy the conversation and its entire message list.
export function applyChatEvents(message: Message, events: RunEvent[], cursor: number): Message {
  let content = message.content, activities = message.activities, error = message.error, progress = message.progress;
  for (const event of events) {
    if (event.type === 'text') content += event.text;
    else if (event.type === 'progress') progress = event.phase;
    else if (event.type === 'activity') activities = [...(activities || []).filter(item => item.id !== event.activity.id), event.activity];
    else if (event.type === 'error') {
      content += `\n\n${event.message}`; error = true;
      activities = activities?.map(item => item.status === 'running' ? { ...item, status: 'error' } : item);
    }
  }
  return { ...message, content, activities, error, progress, eventCursor: cursor };
}
