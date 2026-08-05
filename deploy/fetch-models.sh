#!/usr/bin/env bash
# Populate deploy/models/ with the box's baked retrieval models (retrieval
# stack v2). The image build COPYs this directory and verifies every file
# against the committed deploy/models.sha256 — so WHERE the bytes come from
# never matters, only that they are the pinned bytes.
#
# Sources, in order:
#   1. The repo's `models-1` GitHub release (our own mirror; works in CI —
#      HuggingFace 403s unauthenticated downloads from datacenter IPs).
#   2. HuggingFace directly, pinned by revision (local dev fallback).
set -euo pipefail
cd "$(dirname "$0")"

MODELS_DIR="models"
NOMIC_REV=e9b6763023c676ca8431644204f50c2b100d9aab
MXBAI_REV=b5c6e9da73abc3711f593f705371cdbe9e0fe422

verify() {
  (cd "$MODELS_DIR" && sha256sum -c ../models.sha256 --quiet) 2>/dev/null ||
    (cd "$MODELS_DIR" && shasum -a 256 -c ../models.sha256 --quiet)
}

if [ -d "$MODELS_DIR" ] && verify; then
  echo "fetch-models: already present and verified"
  exit 0
fi

mkdir -p "$MODELS_DIR"

if command -v gh > /dev/null && gh release view models-1 > /dev/null 2>&1; then
  echo "fetch-models: downloading from the models-1 release"
  tmp=$(mktemp -d)
  gh release download models-1 --dir "$tmp" --pattern '*.tar.gz'
  for f in "$tmp"/*.tar.gz; do tar xzf "$f" -C "$MODELS_DIR"; done
  rm -rf "$tmp"
else
  echo "fetch-models: downloading from HuggingFace (pinned revisions)"
  hf() { # repo rev file dest
    curl -fsSL "https://huggingface.co/$1/resolve/$2/$3" -o "$4" ||
      { echo "fetch-models: download failed for $1/$3" >&2; exit 1; }
  }
  for f in config.json tokenizer.json tokenizer_config.json special_tokens_map.json; do
    mkdir -p "$MODELS_DIR/nomic-embed-text-v1.5/onnx" "$MODELS_DIR/mxbai-rerank-xsmall-v1/onnx"
    hf nomic-ai/nomic-embed-text-v1.5 "$NOMIC_REV" "$f" "$MODELS_DIR/nomic-embed-text-v1.5/$f"
    hf mixedbread-ai/mxbai-rerank-xsmall-v1 "$MXBAI_REV" "$f" "$MODELS_DIR/mxbai-rerank-xsmall-v1/$f"
  done
  hf nomic-ai/nomic-embed-text-v1.5 "$NOMIC_REV" onnx/model_quantized.onnx \
    "$MODELS_DIR/nomic-embed-text-v1.5/onnx/model_quantized.onnx"
  hf mixedbread-ai/mxbai-rerank-xsmall-v1 "$MXBAI_REV" onnx/model_quantized.onnx \
    "$MODELS_DIR/mxbai-rerank-xsmall-v1/onnx/model_quantized.onnx"
fi

verify && echo "fetch-models: verified against models.sha256"
