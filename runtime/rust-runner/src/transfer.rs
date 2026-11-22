use anyhow::{Context, Result, ensure};
use base64::{Engine, engine::general_purpose::STANDARD};
use icu_collator::{Collator, options::CollatorOptions};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    fs,
    path::{Component, Path},
};

use crate::{directory, write_private};

const ROOTS: [&str; 4] = [
    "private",
    "profile/MEMORY.md",
    "profile/USER.md",
    "profile/skills",
];
const LIMIT: usize = 20_000_000;

#[derive(Deserialize, Serialize)]
struct Bundle {
    files: Vec<Entry>,
    checksum: String,
}

#[derive(Deserialize, Serialize)]
struct Entry {
    path: String,
    data: String,
    checksum: String,
}

pub fn import(root: &Path, value: &Value) -> Result<Value> {
    let bundle: Bundle =
        serde_json::from_value(value.clone()).context("Invalid agent transfer bundle")?;
    let mut size = 0;
    let mut paths = BTreeSet::new();
    let mut verified = Vec::new();
    for file in &bundle.files {
        let path = Path::new(&file.path);
        ensure!(
            is_allowed(path) && paths.insert(path),
            "Invalid transfer file path."
        );
        let data = STANDARD
            .decode(&file.data)
            .context("Invalid transfer file encoding")?;
        size += data.len();
        ensure!(
            size <= LIMIT && digest(&data) == file.checksum,
            "Transfer file checksum or size is invalid."
        );
        verified.push((path, data));
    }
    // The coordinator already sends the manifest in its locale collation order.
    ensure!(
        checksum(&bundle.files) == bundle.checksum,
        "Transfer manifest checksum is invalid."
    );
    for (path, data) in verified {
        let mut parent = root.to_owned();
        for part in path
            .parent()
            .context("Invalid transfer destination")?
            .components()
        {
            parent.push(part);
            directory(&parent)?;
        }
        write_private(&root.join(path), &data)?;
    }
    Ok(json!({"checksum": bundle.checksum, "files": bundle.files.len(), "validated": true}))
}

pub fn export(root: &Path) -> Result<Value> {
    let mut files = Vec::new();
    let mut size = 0;
    for path in ROOTS {
        collect(root, Path::new(path), &mut files, &mut size, 0)?;
    }
    // Node's localeCompare uses ICU collation. The manifest is sorted again by
    // the coordinator during import, so code-point ordering would break moves.
    let collator = Collator::try_new(Default::default(), CollatorOptions::default())
        .expect("compiled ICU collation data");
    files.sort_by(|a, b| collator.compare(&a.path, &b.path));
    let checksum = checksum(&files);
    Ok(serde_json::to_value(Bundle { files, checksum })?)
}

fn is_allowed(path: &Path) -> bool {
    !path.as_os_str().as_encoded_bytes().contains(&b'\\')
        && path
            .components()
            .all(|part| matches!(part, Component::Normal(_)))
        && (path.starts_with("private")
            || path.starts_with("profile/skills")
            || path == Path::new("profile/MEMORY.md")
            || path == Path::new("profile/USER.md"))
}

fn collect(
    root: &Path,
    relative: &Path,
    files: &mut Vec<Entry>,
    size: &mut usize,
    depth: usize,
) -> Result<()> {
    let path = root.join(relative);
    let stat = match path.symlink_metadata() {
        Ok(stat) => stat,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    ensure!(
        depth <= 128,
        "Managed files are nested too deeply to transfer."
    );
    if stat.is_dir() {
        for entry in fs::read_dir(&path)? {
            collect(
                root,
                &relative.join(entry?.file_name()),
                files,
                size,
                depth + 1,
            )?;
        }
    } else if stat.is_file() {
        ensure!(
            stat.len() <= (LIMIT - *size) as u64,
            "Managed agent data exceeds the 20 MB transfer limit."
        );
        let data = fs::read(&path)?;
        *size += data.len();
        ensure!(
            *size <= LIMIT && is_allowed(relative),
            "Invalid managed file path or size."
        );
        files.push(Entry {
            path: relative
                .to_str()
                .context("Managed file path is not UTF-8")?
                .to_owned(),
            data: STANDARD.encode(&data),
            checksum: digest(&data),
        });
    }
    Ok(())
}

fn checksum(files: &[Entry]) -> String {
    digest(
        files
            .iter()
            .map(|file| format!("{}:{}", file.path, file.checksum))
            .collect::<Vec<_>>()
            .join("\n")
            .as_bytes(),
    )
}

fn digest(data: &[u8]) -> String {
    format!("{:x}", Sha256::digest(data))
}
