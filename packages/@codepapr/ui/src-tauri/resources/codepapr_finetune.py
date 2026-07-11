#!/usr/bin/env python3
"""
CodePapr fine-tuning script — replicates the GPT-SoVITS WebUI training flow.
Usage:
    python3 codepapr_finetune.py --train_dir ... --output_dir ... --epochs 30
"""
import argparse, json, os, shutil, subprocess, sys, tempfile

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--train_dir", required=True)
    parser.add_argument("--output_dir", required=True)
    parser.add_argument("--epochs", type=int, default=30)
    parser.add_argument("--batch_size", type=int, default=1)
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

    import json as _json
    def emit_progress(step, percent):
        print(f"PROGRESS::{_json.dumps({'step': step, 'percent': percent})}", flush=True)

    print(f"[codepapr] {len(lines)} training samples loaded", flush=True)

    # Import phoneme converter
    try:
        from GPT_SoVITS.text.cleaner import clean_text
    except Exception:
        clean_text = None

    # Import model configs
    try:
        from config import (
            pretrained_sovits_name, cnhubert_path,
            SoVITS_weight_version2root,
        )
    except Exception as e:
        print(f"ERROR: Cannot import config: {e}", flush=True)
        sys.exit(1)

    version = "v4"
    pretrained_s2G = pretrained_sovits_name.get(version, "")
    if pretrained_s2G and not os.path.exists(os.path.join(script_dir, pretrained_s2G)):
        pretrained_s2G = ""
    pretrained_s2D = ""  # No discriminator pretrained for v4
    save_weight_dir = SoVITS_weight_version2root.get(version, "SoVITS_weights_v4")
    exp_name = "codepapr_tune"
    exp_root = args.output_dir
    s2_dir = os.path.join(exp_root, exp_name)

    # Step 1: Preprocess
    print("[codepapr] Step 1/4: Preprocessing audio...", flush=True)
    emit_progress("preprocess", 2)
    wav32k_dir = os.path.join(s2_dir, "5-wav32k")
    hubert_dir = os.path.join(s2_dir, "4-cnhubert")
    name2text_path = os.path.join(s2_dir, "2-name2text.txt")
    os.makedirs(wav32k_dir, exist_ok=True)
    os.makedirs(hubert_dir, exist_ok=True)

    import librosa, soundfile as sf, numpy as np, torch
    from scipy import signal as scipy_signal
    name2text_lines = []
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

        phonemes = text
        if clean_text:
            try:
                phones, word2ph, norm_text = clean_text(text, lang, version)
                phonemes = " ".join(phones)
            except Exception:
                pass
        name2text_lines.append(f"{base}\t{phonemes}\t{speaker}\t{text}")

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
        device = "cpu"
        if torch.cuda.is_available():
            device = "cuda"
        elif hasattr(torch.backends, 'mps') and torch.backends.mps.is_available():
            device = "mps"
        cnhubert = cnhubert.to(device)

        for i, parts in enumerate(lines):
            wav_name = parts[0]
            base = os.path.splitext(wav_name)[0]
            hubert_path = os.path.join(hubert_dir, f"{base}.pt")
            if os.path.exists(hubert_path):
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
                audio_tensor = torch.from_numpy(data).float().to(device)
                with torch.no_grad():
                    features = cnhubert(audio_tensor)
                # Transpose to [batch, hidden, seq] as expected by V4 loader
                features = features.transpose(1, 2)
                torch.save(features.cpu(), hubert_path)
                if (i + 1) % 5 == 0:
                    print(f"  HuBERT: {i+1}/{len(lines)}", flush=True)
            except Exception as e:
                print(f"  HuBERT failed {base}: {e}", flush=True)
        print(f"  HuBERT features extracted to {hubert_dir}", flush=True)
        emit_progress("hubert", 14)
    except Exception as e:
        print(f"  HuBERT init failed: {e}, but training can continue", flush=True)

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
    data["train"]["gpu_numbers"] = "0"
    data["train"]["grad_ckpt"] = False
    data["train"]["lora_rank"] = 4
    data["train"]["fp16_run"] = True
    data["model"]["version"] = version
    data["data"]["exp_dir"] = data["s2_ckpt_dir"] = s2_dir
    data["data"]["n_speakers"] = 1
    data["save_weight_dir"] = save_weight_dir
    data["name"] = exp_name
    data["version"] = version
    data["model_dir"] = s2_dir

    os.makedirs(os.path.join(s2_dir, f"logs_s2_{version}"), exist_ok=True)
    # Create save_weight_dir so savee() can write the inference model
    save_weight_abs = os.path.join(script_dir, save_weight_dir)
    os.makedirs(save_weight_abs, exist_ok=True)
    # Remove previous run's artifacts to prevent lexicographic cross-contamination
    for old_pth in [f for f in os.listdir(save_weight_abs) if f.endswith(".pth")]:
        os.remove(os.path.join(save_weight_abs, old_pth))

    tmp_config = os.path.join(s2_dir, "tmp_s2.json")
    with open(tmp_config, "w") as f:
        json.dump(data, f, indent=2)
    print(f"  Config written to {tmp_config}", flush=True)

    # Step 4: Run training
    print("[codepapr] Step 4/4: Starting LoRA fine-tuning...", flush=True)
    emit_progress("train", 20)
    train_script = os.path.join(gpt_sovits_dir, "s2_train_v3_lora.py")

    python_exe = sys.executable
    env = os.environ.copy()
    env["PYTHONUNBUFFERED"] = "1"
    env["PYTORCH_ENABLE_MPS_FALLBACK"] = "1"
    env["PYTHONPATH"] = script_dir + os.pathsep + gpt_sovits_dir + os.pathsep + env.get("PYTHONPATH", "")
    env["TOKENIZERS_PARALLELISM"] = "false"

    # Run as subprocess
    cmd = [python_exe, "-u", train_script, "--config", tmp_config]
    print(f"  Running: {' '.join(cmd)}", flush=True)

    proc = subprocess.Popen(
        cmd, cwd=script_dir, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        env=env, text=True, bufsize=1,
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
    found = False
    if os.path.isdir(save_weight_abs):
        candidates = sorted(
            [f for f in os.listdir(save_weight_abs) if f.endswith(".pth")],
            reverse=True,
        )
        for f in candidates:
            src = os.path.join(save_weight_abs, f)
            dst = os.path.join(args.output_dir, "s2Gv4.pth")
            shutil.copy2(src, dst)
            size_mb = os.path.getsize(dst) / 1024 / 1024
            print(f"[codepapr] Inference model saved to {dst} ({size_mb:.0f} MB)", flush=True)
            found = True
            break
    if not found:
        print("[codepapr] WARNING: Could not find inference model in save_weight_dir.", flush=True)
        print(f"[codepapr] Checked: {save_weight_abs}", flush=True)

if __name__ == "__main__":
    main()
