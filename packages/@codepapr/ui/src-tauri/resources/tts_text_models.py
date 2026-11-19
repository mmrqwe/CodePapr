"""Prepare the language models GPT-SoVITS otherwise downloads at first use."""

import hashlib
import os
import shutil
import sys
import urllib.request
from pathlib import Path, PurePosixPath
from zipfile import ZipFile


def download(url, target, size, sha256, verify_existing=False):
    if target.is_file() and target.stat().st_size == size:
        if not verify_existing:
            return
        digest = hashlib.sha256()
        with target.open("rb") as source:
            for chunk in iter(lambda: source.read(1 << 20), b""):
                digest.update(chunk)
        if digest.hexdigest() == sha256:
            return
    print(f"Downloading {target.name} ({size // (1024 * 1024)} MiB)...")
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_suffix(target.suffix + ".part")
    try:
        digest = hashlib.sha256()
        with urllib.request.urlopen(url, timeout=60) as response, temporary.open("wb") as output:
            for chunk in iter(lambda: response.read(1 << 20), b""):
                digest.update(chunk)
                output.write(chunk)
        if temporary.stat().st_size != size or digest.hexdigest() != sha256:
            raise ValueError(f"Invalid size or checksum for {target.name}")
        os.replace(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)


def prepare(root):
    download(
        "https://dl.fbaipublicfiles.com/fasttext/supervised-models/lid.176.bin",
        root / "pretrained_models" / "fast_langdetect" / "lid.176.bin",
        131_266_198,
        "7e69ec5451bc261cc7844e49e4792a85d7f09c06789ec800fc4a44aec362764e",
    )
    text = root / "text"
    archive = text / "G2PWModel_1.1.zip"
    output = text / "G2PWModel"
    required = ("g2pW.onnx", "config.py", "char_bopomofo_dict.json",
                "bopomofo_to_pinyin_wo_tune_dict.json", "MONOPHONIC_CHARS.txt", "POLYPHONIC_CHARS.txt")
    sizes = (635_212_732, 347, 1_851_143, 7_739, 120_744, 102_444)
    if all((output / name).is_file() and (output / name).stat().st_size == size
           for name, size in zip(required, sizes)):
        return
    download(
        "https://www.modelscope.cn/models/kamiorinn/g2pw/resolve/master/G2PWModel_1.1.zip",
        archive,
        588_857_174,
        "b116f6930a7ee55eef6576a8d8e14bf40c1106583439e8ae924b901512379c64",
        verify_existing=True,
    )
    print("Extracting the G2PW pronunciation model...")
    output.mkdir(parents=True, exist_ok=True)
    with ZipFile(archive) as bundle:
        for member in bundle.infolist():
            path = PurePosixPath(member.filename)
            if member.is_dir() or path.parent != PurePosixPath("G2PWModel_1.1"):
                continue
            target = output / path.name
            if target.is_file() and target.stat().st_size == member.file_size:
                continue
            temporary = target.with_suffix(target.suffix + ".part")
            try:
                with bundle.open(member) as source, temporary.open("wb") as destination:
                    shutil.copyfileobj(source, destination, length=1 << 20)
                os.replace(temporary, target)
            finally:
                temporary.unlink(missing_ok=True)


if __name__ == "__main__":
    prepare(Path(sys.argv[1]) / "GPT_SoVITS")
