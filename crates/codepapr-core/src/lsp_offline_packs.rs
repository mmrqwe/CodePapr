use serde::Deserialize;
use std::{
    collections::BTreeMap,
    fs::{self, OpenOptions},
    path::{Component, Path, PathBuf},
    sync::OnceLock,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Pack {
    sha256: String,
    archive_bytes: u64,
    expanded_bytes: u64,
    probes: Vec<String>,
}

struct Packs {
    source: PathBuf,
    entries: BTreeMap<String, Pack>,
}

impl Packs {
    fn load(source: PathBuf) -> Result<Option<Self>, String> {
        let bytes = match fs::read(source.join("packs.json")) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(format!("读取离线 LSP 清单失败: {error}")),
        };
        let entries: BTreeMap<String, Pack> = serde_json::from_slice(&bytes)
            .map_err(|error| format!("解析离线 LSP 清单失败: {error}"))?;
        for (name, pack) in &entries {
            if name.is_empty()
                || !name.bytes().all(|c| c.is_ascii_lowercase() || c == b'-')
                || pack.sha256.len() != 64
                || !pack.sha256.bytes().all(|c| c.is_ascii_hexdigit())
                || pack.probes.is_empty()
                || pack.probes.iter().any(|probe| {
                    probe.is_empty()
                        || !Path::new(probe)
                            .components()
                            .all(|c| matches!(c, Component::Normal(_)))
                })
            {
                return Err(format!("离线 LSP 清单包含无效条目: {name}"));
            }
        }
        Ok(Some(Self { source, entries }))
    }

    fn materialize(&self, cache: &Path, name: &str) -> Result<Option<PathBuf>, String> {
        let Some(pack) = self.entries.get(name) else {
            return Ok(None);
        };
        let target = pack.cache_root(cache, name);
        if pack.is_ready(&target, name) {
            return Ok(Some(target));
        }
        fs::create_dir_all(cache).map_err(|error| format!("创建离线 LSP 缓存失败: {error}"))?;
        let lock = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(false)
            .open(cache.join(format!("{name}.lock")))
            .map_err(|error| format!("打开离线 LSP 缓存锁失败: {error}"))?;
        lock.lock()
            .map_err(|error| format!("获取离线 LSP 缓存锁失败: {error}"))?;
        if pack.is_ready(&target, name) {
            return Ok(Some(target));
        }

        let archive = self.source.join(format!("{name}.zip"));
        if fs::metadata(&archive).map(|meta| meta.len()).ok() != Some(pack.archive_bytes) {
            return Err(format!("离线 LSP 工具包缺失或长度不符: {name}"));
        }
        crate::download_verification::verify_sha256(&archive, &pack.sha256)
            .map_err(|error| format!("离线 LSP 工具包校验失败 ({name}): {error}"))?;
        let stage = cache.join(format!(
            ".{name}-{}-{}.stage",
            std::process::id(),
            super::monotonic_nanos()
        ));
        fs::create_dir(&stage).map_err(|error| format!("创建离线 LSP 暂存目录失败: {error}"))?;
        let result = (|| {
            super::extract_zip(&archive, &stage)?;
            if !pack.has_tools(&stage, name) {
                return Err(format!("离线 LSP 工具包缺少必要文件: {name}"));
            }
            fs::write(stage.join(".ready"), &pack.sha256)
                .map_err(|error| format!("写入离线 LSP 完成标记失败: {error}"))?;
            if target.exists() {
                fs::remove_dir_all(&target)
                    .map_err(|error| format!("移除损坏的离线 LSP 缓存失败: {error}"))?;
            }
            fs::rename(&stage, &target)
                .map_err(|error| format!("提交离线 LSP 缓存失败: {error}"))?;
            Ok(Some(target))
        })();
        if result.is_err() {
            let _ = fs::remove_dir_all(stage);
        }
        result
    }
}

impl Pack {
    fn cache_root(&self, cache: &Path, name: &str) -> PathBuf {
        cache.join(format!("{name}-{}", &self.sha256[..20]))
    }

    fn has_tools(&self, root: &Path, name: &str) -> bool {
        let tools = root.join(name);
        self.probes.iter().all(|probe| tools.join(probe).is_file())
    }

    fn is_ready(&self, root: &Path, name: &str) -> bool {
        fs::read_to_string(root.join(".ready")).ok().as_deref() == Some(&self.sha256)
            && self.has_tools(root, name)
    }
}

fn bundled() -> Result<Option<&'static Packs>, String> {
    static PACKS: OnceLock<Result<Option<Packs>, String>> = OnceLock::new();
    PACKS
        .get_or_init(|| {
            let executable = std::env::current_exe().map_err(|error| error.to_string())?;
            let Some(dir) = executable.parent() else {
                return Ok(None);
            };
            Packs::load(dir.join("_up_").join("generated").join("lsp-packs"))
        })
        .as_ref()
        .map(|packs| packs.as_ref())
        .map_err(Clone::clone)
}

pub(super) fn prepare(name: &str) -> Result<Option<PathBuf>, String> {
    let Some(packs) = bundled()? else {
        return Ok(None);
    };
    if !packs.entries.contains_key(name) {
        return Ok(None);
    }
    let cache = super::managed_install_root()?.join("offline");
    packs.materialize(&cache, name)
}

pub(super) fn cached_roots(cache: &Path) -> Vec<PathBuf> {
    let Ok(Some(packs)) = bundled() else {
        return Vec::new();
    };
    packs
        .entries
        .iter()
        .filter_map(|(name, pack)| {
            let root = pack.cache_root(cache, name);
            pack.is_ready(&root, name).then_some(root)
        })
        .collect()
}

pub(super) fn is_cached(name: &str) -> bool {
    let Some((packs, cache)) = bundled().ok().flatten().zip(super::app_data_root()) else {
        return false;
    };
    let cache = cache.join("lsp-tools").join("offline");
    packs
        .entries
        .get(name)
        .is_some_and(|pack| pack.is_ready(&pack.cache_root(&cache, name), name))
}

pub(super) fn packed_tool(name: &str) -> Option<(PathBuf, u64)> {
    let packs = bundled().ok()??;
    let pack = packs.entries.get(name)?;
    let archive = packs.source.join(format!("{name}.zip"));
    if fs::metadata(&archive).ok()?.len() != pack.archive_bytes {
        return None;
    }
    Some((archive, pack.expanded_bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};
    use std::io::Write;

    #[test]
    fn complete_pack_is_reused_and_missing_tool_is_repaired() {
        let root = std::env::temp_dir().join(format!(
            "codepapr-offline-pack-{}-{}",
            std::process::id(),
            super::super::monotonic_nanos(),
        ));
        fs::create_dir(&root).unwrap();
        let archive = root.join("marksman.zip");
        let mut writer = zip::ZipWriter::new(fs::File::create(&archive).unwrap());
        writer
            .start_file(
                "marksman/bin/marksman.exe",
                zip::write::SimpleFileOptions::default(),
            )
            .unwrap();
        writer.write_all(b"fixture").unwrap();
        drop(writer.finish().unwrap());
        let bytes = fs::read(&archive).unwrap();
        fs::write(
            root.join("packs.json"),
            serde_json::json!({
                "marksman": {
                    "sha256": format!("{:x}", Sha256::digest(&bytes)),
                    "archiveBytes": bytes.len(),
                    "expandedBytes": 7,
                    "probes": ["bin/marksman.exe"],
                },
            })
            .to_string(),
        )
        .unwrap();
        let packs = Packs::load(root.clone()).unwrap().unwrap();
        let cache = root.join("cache");
        let target = packs.materialize(&cache, "marksman").unwrap().unwrap();
        let tool = target.join("marksman/bin/marksman.exe");
        assert_eq!(fs::read(&tool).unwrap(), b"fixture");

        fs::remove_file(&archive).unwrap();
        assert_eq!(
            packs.materialize(&cache, "marksman").unwrap(),
            Some(target.clone())
        );
        fs::remove_file(&tool).unwrap();
        assert!(packs.materialize(&cache, "marksman").is_err());
        fs::write(&archive, bytes).unwrap();
        assert_eq!(packs.materialize(&cache, "marksman").unwrap(), Some(target));
        assert_eq!(fs::read(&tool).unwrap(), b"fixture");
        fs::remove_dir_all(root).unwrap();
    }
}
