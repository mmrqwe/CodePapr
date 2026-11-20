use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::{self, BufReader, BufWriter, Read},
    path::{Path, PathBuf},
};
use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};

pub const PACKS: &[(&str, &[&str])] = &[
    ("clangd", &["bin/clangd.exe"]),
    ("csharp-ls", &["bin/csharp-ls.exe"]),
    ("dotnet-sdk", &["dotnet.exe"]),
    ("gopls", &["bin/gopls.exe"]),
    ("java", &["jre/bin/java.exe", "jdtls/config_win/config.ini"]),
    ("marksman", &["bin/marksman.exe"]),
    (
        "node-packages",
        &[
            "node_modules/typescript-language-server/lib/cli.mjs",
            "node_modules/vscode-langservers-extracted/bin/vscode-html-language-server",
            "node_modules/yaml-language-server/bin/yaml-language-server",
            "node_modules/pyright/langserver.index.js",
            "node_modules/bash-language-server/out/cli.js",
        ],
    ),
    ("rust-analyzer", &["bin/rust-analyzer.exe"]),
    ("sqls", &["bin/sqls.exe"]),
];

pub fn prepare(source: &Path, destination: &Path) -> Result<(), Box<dyn std::error::Error>> {
    fs::create_dir_all(destination)?;
    let manifest_path = destination.join("packs.json");
    let previous: Value = fs::read(&manifest_path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default();
    let mut packs = serde_json::Map::new();
    for &(name, expected_probes) in PACKS {
        let root = source.join(name);
        let archive = destination.join(format!("{name}.zip"));
        let mut files = Vec::new();
        if root.is_dir() {
            println!("cargo:rerun-if-changed={}", root.display());
            collect_files(&root, &root, &mut files)?;
        }
        if files.is_empty() {
            if archive.is_file() {
                fs::remove_file(archive)?;
            }
            continue;
        }
        files.sort();
        let mut digest = Sha256::new();
        digest.update(b"codepapr-windows-lsp-zip-v1\0");
        let mut bytes = 0;
        for (relative, file) in &files {
            digest.update(relative.as_bytes());
            digest.update([0]);
            let size = file.metadata()?.len();
            bytes += size;
            digest.update(size.to_le_bytes());
            update_hash(file, &mut digest)?;
        }
        let source_sha256 = format!("{:x}", digest.finalize());
        let archive_bytes = archive.metadata().ok().map(|meta| meta.len());
        let old = &previous[name];
        if old["sourceSha256"].as_str() == Some(source_sha256.as_str())
            && old["archiveBytes"].as_u64().is_some()
            && old["archiveBytes"].as_u64() == archive_bytes
            && old["sha256"].as_str() == Some(&file_hash(&archive)?)
        {
            println!("cargo:warning=using cached LSP archive: {name}");
            packs.insert(name.to_string(), old.clone());
            continue;
        }

        println!("cargo:warning=compressing LSP archive: {name}");
        let stage = archive.with_extension(format!("stage-{}", std::process::id()));
        let result = (|| -> Result<Value, Box<dyn std::error::Error>> {
            let mut zip = ZipWriter::new(BufWriter::new(File::create(&stage)?));
            let options = SimpleFileOptions::default()
                .compression_method(CompressionMethod::Deflated)
                .compression_level(Some(1));
            for (relative, file) in &files {
                zip.start_file(format!("{name}/{relative}"), options)?;
                io::copy(&mut BufReader::new(File::open(file)?), &mut zip)?;
            }
            let mut finished = zip.finish()?;
            io::Write::flush(&mut finished)?;
            drop(finished);
            let mut probes = expected_probes
                .iter()
                .filter(|probe| root.join(probe).is_file())
                .map(|probe| (*probe).to_string())
                .collect::<Vec<_>>();
            if name == "java" {
                probes.extend(files.iter().filter_map(|(relative, _)| {
                    relative
                        .starts_with("jdtls/plugins/org.eclipse.equinox.launcher_")
                        .then(|| relative.clone())
                }));
            }
            if probes.is_empty() {
                probes.push(files[0].0.clone());
            }
            let value = json!({
                "sourceSha256": source_sha256,
                "sha256": file_hash(&stage)?,
                "archiveBytes": stage.metadata()?.len(),
                "expandedBytes": bytes,
                "probes": probes,
            });
            fs::rename(&stage, &archive)?;
            Ok(value)
        })();
        if result.is_err() {
            let _ = fs::remove_file(stage);
        }
        packs.insert(name.to_string(), result?);
    }
    let bytes = serde_json::to_vec_pretty(&packs)?;
    if fs::read(&manifest_path).ok().as_deref() != Some(&bytes) {
        fs::write(manifest_path, bytes)?;
    }
    Ok(())
}

fn collect_files(
    root: &Path,
    current: &Path,
    files: &mut Vec<(String, PathBuf)>,
) -> io::Result<()> {
    for entry in fs::read_dir(current)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        let file = entry.path();
        if kind.is_dir() {
            collect_files(root, &file, files)?;
        } else if kind.is_file() {
            let relative = file.strip_prefix(root).expect("inside LSP input directory");
            let name = relative.to_str().ok_or_else(|| {
                io::Error::new(io::ErrorKind::InvalidData, "non-UTF-8 path in LSP bundle")
            })?;
            files.push((name.replace('\\', "/"), file));
        }
    }
    Ok(())
}

fn update_hash(path: &Path, hasher: &mut Sha256) -> io::Result<()> {
    let mut input = BufReader::new(File::open(path)?);
    let mut buffer = [0; 64 * 1024];
    loop {
        let n = input.read(&mut buffer)?;
        if n == 0 {
            return Ok(());
        }
        hasher.update(&buffer[..n]);
    }
}

fn file_hash(path: &Path) -> io::Result<String> {
    let mut hash = Sha256::new();
    update_hash(path, &mut hash)?;
    Ok(format!("{:x}", hash.finalize()))
}
