#!/usr/bin/env python3
"""
CodePapr fine-tuning script — replicates the GPT-SoVITS WebUI training flow.
Usage:
    python3 codepapr_finetune.py --train_dir ... --output_dir ... --epochs 30
"""
import argparse, json, os, shutil, subprocess, sys


def training_device(requested, torch):
    if requested == "auto":
        if torch.cuda.is_available():
            return "cuda"
        if torch.backends.mps.is_available():
            return "mps"
        return "cpu"
    available = {
        "cuda": torch.cuda.is_available,
        "mps": torch.backends.mps.is_available,
    }
    if requested in available and not available[requested]():
        raise RuntimeError(f"Requested training device {requested} is unavailable")
    return requested


def run_trainer():
    requested, config = sys.argv[1:]
    sys.argv = ["s2_train_v3_lora.py", "--config", config]
    import s2_train_v3_lora as trainer
    import torch

    device = training_device(requested, torch)
    if device == "cuda":
        print(f"[codepapr] LoRA training on CUDA: {torch.cuda.get_device_name(0)}", flush=True)
    else:
        print(f"[codepapr] LoRA training on {device.upper()}", flush=True)
    # The upstream trainer already moves its model and batches to this device
    # on the non-CUDA path. It defaults to CPU even when MPS is available.
    trainer.device = device
    trainer.run(0, 1, trainer.hps)


def training_phones(text, language, version):
    from text.cleaner import clean_text
    from text.LangSegmenter import LangSegmenter

    language = language.strip().lower()
    lang = language.removeprefix("all_")
    if lang == "en":
        return clean_text(text, lang, version)[0]
    if lang not in {"zh", "yue", "ja", "ko", "auto", "auto_yue"}:
        raise ValueError(f"Unsupported training language: {language}")
    if language.startswith("all_") and lang in {"zh", "yue", "ja", "ko"}:
        segments = LangSegmenter.getTexts(text, "zh" if lang == "yue" else lang)
    else:
        segments = LangSegmenter.getTexts(text)
    phones = []
    for segment in segments:
        segment_lang = segment["lang"]
        if lang == "auto_yue" and segment_lang == "zh":
            segment_lang = "yue"
        elif lang not in {"auto", "auto_yue"} and segment_lang != "en":
            segment_lang = lang
        phones.extend(clean_text(segment["text"], segment_lang, version)[0])
    return phones


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--train_dir", required=True)
    parser.add_argument("--output_dir", required=True)
    parser.add_argument("--epochs", type=int, default=30)
    parser.add_argument("--batch_size", type=int, default=1)
    parser.add_argument("--device", choices=("auto", "cuda", "mps", "cpu"), default="auto")
    args = parser.parse_args()

    script_dir = os.path.dirname(os.path.abspath(__file__))
    gpt_sovits_dir = os.path.join(script_dir, "GPT_SoVITS")
    sys.path.insert(0, script_dir)
    sys.path.insert(0, gpt_sovits_dir)

    meta_path = os.path.join(args.train_dir, "metadata.list")
    if not os.path.exists(meta_path):
        print(f"ERROR: metadata.list not found at {meta_path}", flush=True)
        sys.exit(1)

    # Read training data
    lines = []
    with open(meta_path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            parts = line.split("|")
            if len(parts) >= 4:
                lines.append(parts)

    if len(lines) < 5:
        print(f"ERROR: Need at least 5 training samples, got {len(lines)}", flush=True)
        sys.exit(1)

    def emit_progress(step, percent):
        print(f"PROGRESS::{json.dumps({'step': step, 'percent': percent, 'device': device})}", flush=True)

    import torch
    device = training_device(args.device, torch)
    print(f"[codepapr] Fine-tuning device: {device.upper()}", flush=True)

    print(f"[codepapr] {len(lines)} training samples loaded", flush=True)

    # Import model configs
    try:
        from config import (
            pretrained_sovits_name, cnhubert_path,
        )
    except Exception as e:
        print(f"ERROR: Cannot import config: {e}", flush=True)
        sys.exit(1)

    version = "v4"
    pretrained_s2G = pretrained_sovits_name.get(version, "")
    if pretrained_s2G and not os.path.exists(os.path.join(script_dir, pretrained_s2G)):
        pretrained_s2G = ""
    pretrained_s2D = ""  # No discriminator pretrained for v4
    exp_name = "codepapr_tune"
    exp_root = os.path.abspath(args.output_dir)
    s2_dir = os.path.join(exp_root, exp_name)
    save_weight_dir = os.path.join(s2_dir, "weights")

    # Step 1: Preprocess
    print("[codepapr] Step 1/4: Preprocessing audio...", flush=True)
    emit_progress("preprocess", 2)
    wav32k_dir = os.path.join(s2_dir, "5-wav32k")
    hubert_dir = os.path.join(s2_dir, "4-cnhubert")
    name2text_path = os.path.join(s2_dir, "2-name2text.txt")
    os.makedirs(wav32k_dir, exist_ok=True)
    os.makedirs(hubert_dir, exist_ok=True)

    import soundfile as sf, numpy as np
    from scipy import signal as scipy_signal
    name2text_lines = []
    usable_wavs = []
    for parts in lines:
        wav_name, speaker, lang, text = parts[0], parts[1], parts[2], parts[3]
        wav_path = os.path.join(args.train_dir, wav_name)
        if not os.path.exists(wav_path):
            print(f"  Skip missing: {wav_name}", flush=True)
            continue

        base = os.path.splitext(wav_name)[0]
        bare = os.path.join(wav32k_dir, base)

        if not os.path.exists(bare):
            try:
                data, sr = sf.read(wav_path)
                if data.ndim > 1:
                    data = data.mean(axis=1)
                if sr != 32000:
                    num_samples = int(len(data) * 32000 / sr)
                    data = scipy_signal.resample(data.astype(float), num_samples)
                data = data.astype(np.float32)
                sf.write(bare, data, 32000, format='WAV')
            except Exception as e:
                print(f"  Resample failed {wav_name}: {e}", flush=True)
                continue

        try:
            phones = training_phones(text, lang, version)
            if not phones:
                raise ValueError("No phonemes for this sample")
        except Exception as e:
            print(f"  Phoneme conversion failed for {wav_name} ({lang}): {e}", flush=True)
            continue
        phonemes = " ".join(phones)
        name2text_lines.append(f"{base}\t{phonemes}\t{speaker}\t{text}")
        usable_wavs.append(wav_name)

    if not name2text_lines:
        print("ERROR: No valid training samples", flush=True)
        sys.exit(1)

    with open(name2text_path, "w", encoding="utf-8") as f:
        f.write("\n".join(name2text_lines))
    print(f"  Wrote {name2text_path} ({len(name2text_lines)} entries)", flush=True)
    emit_progress("preprocess", 4)

    # Step 2: HuBERT features
    print("[codepapr] Step 2/4: Extracting HuBERT features...", flush=True)
    emit_progress("hubert", 6)
    try:
        from GPT_SoVITS.feature_extractor.cnhubert import CNHubert
        cnhubert = CNHubert(base_path=cnhubert_path)
        cnhubert.eval()
        cnhubert = cnhubert.to(device)
        print(f"[codepapr] HuBERT feature extraction on {next(cnhubert.parameters()).device}", flush=True)

        feature_count = 0
        for i, wav_name in enumerate(usable_wavs):
            base = os.path.splitext(wav_name)[0]
            hubert_path = os.path.join(hubert_dir, f"{base}.pt")
            if os.path.exists(hubert_path):
                feature_count += 1
                continue
            wav_path = os.path.join(wav32k_dir, base)
            try:
                data, sr = sf.read(wav_path)
                if data.ndim > 1:
                    data = data.mean(axis=1)
                if sr != 16000:
                    from scipy import signal as scipy_signal
                    num_samples = int(len(data) * 16000 / sr)
                    data = scipy_signal.resample(data.astype(float), num_samples)
                data = data.astype(np.float32)
                with torch.no_grad():
                    inputs = cnhubert.feature_extractor(data, sampling_rate=16000, return_tensors="pt")
                    features = cnhubert.model(inputs.input_values.to(device)).last_hidden_state
                # Transpose to [batch, hidden, seq] as expected by V4 loader
                torch.save(features.transpose(1, 2).cpu(), hubert_path)
                feature_count += 1
                if (i + 1) % 5 == 0:
                    print(f"  HuBERT: {i+1}/{len(usable_wavs)}", flush=True)
            except Exception as e:
                print(f"  HuBERT failed {base}: {e}", flush=True)
        if feature_count == 0:
            raise RuntimeError("No usable HuBERT features were produced")
        print(f"  {feature_count} HuBERT feature files in {hubert_dir}", flush=True)
        emit_progress("hubert", 14)
    except Exception as e:
        raise RuntimeError(f"Cannot extract HuBERT features on {device}: {e}") from e
    # Release the feature model's GPU memory before starting LoRA.
    del cnhubert
    if device == "cuda":
        torch.cuda.empty_cache()
    elif device == "mps":
        torch.mps.empty_cache()

    # Step 3: Create config (matching WebUI exactly)
    print("[codepapr] Step 3/4: Creating training config...", flush=True)
    emit_progress("config", 16)

    config_path = os.path.join(gpt_sovits_dir, "configs", "s2.json")
    with open(config_path) as f:
        data = json.loads(f.read())

    data["train"]["batch_size"] = args.batch_size
    data["train"]["epochs"] = args.epochs
    data["train"]["text_low_lr_rate"] = 0.4
    data["train"]["pretrained_s2G"] = pretrained_s2G
    data["train"]["pretrained_s2D"] = pretrained_s2D
    data["train"]["if_save_latest"] = True
    data["train"]["if_save_every_weights"] = True  # inference model via savee()
    data["train"]["save_every_epoch"] = 1
    data["train"]["gpu_numbers"] = os.environ.get("CUDA_VISIBLE_DEVICES", "0").split(",")[0] if device == "cuda" else ""
    data["train"]["grad_ckpt"] = False
    data["train"]["lora_rank"] = 4
    data["train"]["fp16_run"] = device == "cuda"
    data["model"]["version"] = version
    data["data"]["exp_dir"] = data["s2_ckpt_dir"] = s2_dir
    data["data"]["n_speakers"] = 1
    data["save_weight_dir"] = save_weight_dir
    data["name"] = exp_name
    data["version"] = version
    data["model_dir"] = s2_dir

    os.makedirs(os.path.join(s2_dir, f"logs_s2_{version}"), exist_ok=True)
    os.makedirs(save_weight_dir, exist_ok=True)

    tmp_config = os.path.join(s2_dir, "tmp_s2.json")
    with open(tmp_config, "w") as f:
        json.dump(data, f, indent=2)
    print(f"  Config written to {tmp_config}", flush=True)

    # Step 4: Run training
    print("[codepapr] Step 4/4: Starting LoRA fine-tuning...", flush=True)
    emit_progress("train", 20)
    python_exe = sys.executable
    env = os.environ.copy()
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONUNBUFFERED"] = "1"
    env["PYTORCH_ENABLE_MPS_FALLBACK"] = "1"
    env["PYTHONPATH"] = script_dir + os.pathsep + gpt_sovits_dir + os.pathsep + env.get("PYTHONPATH", "")
    env["TOKENIZERS_PARALLELISM"] = "false"
    if device != "cuda":
        env["CUDA_VISIBLE_DEVICES"] = ""

    # Run as subprocess
    cmd = [python_exe, "-u", "-c", "from codepapr_finetune import run_trainer; run_trainer()", device, tmp_config]
    print(f"  Running: {' '.join(cmd)}", flush=True)

    proc = subprocess.Popen(
        cmd, cwd=script_dir, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        env=env, text=True, encoding="utf-8", errors="replace", bufsize=1,
    )

    total_epochs = args.epochs
    for line in proc.stdout:
        line = line.rstrip()
        print(line, flush=True)
        if line.startswith("Epoch:"):
            try:
                parts = line.split("Epoch:")[1].strip().split("/")
                epoch = float(parts[0]) if parts else 0.0
                pct = 25.0 + (epoch / max(total_epochs, 1)) * 70.0
                emit_progress("train", int(min(pct, 95)))
            except (ValueError, IndexError):
                pass

    proc.wait()

    if proc.returncode != 0:
        print(f"ERROR: Training exited with code {proc.returncode}", flush=True)
        sys.exit(proc.returncode)

    # Find the inference model saved by savee() into save_weight_dir.
    # These are pure weight files (no optimizer state), half-precision,
    # ready for inference. Naming pattern: {name}_e{epoch}_s{step}_l{rank}.pth
    checkpoints = [os.path.join(save_weight_dir, f) for f in os.listdir(save_weight_dir) if f.endswith(".pth")]
    if not checkpoints:
        raise RuntimeError(f"Training produced no inference model in {save_weight_dir}")
    src = max(checkpoints, key=os.path.getmtime)
    dst = os.path.join(exp_root, "s2Gv4.pth")
    shutil.copy2(src, dst)
    size_mb = os.path.getsize(dst) / 1024 / 1024
    print(f"[codepapr] Inference model saved to {dst} ({size_mb:.0f} MB)", flush=True)

if __name__ == "__main__":
    main()
