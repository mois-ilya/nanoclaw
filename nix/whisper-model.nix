# ggml model files for whisper-server, from ggerganov/whisper.cpp on Hugging Face.
# `small` is multilingual (the default); `large-v3-turbo-q5_0` is the opt-in upgrade.
# Hashes are for a pinned revision of the repo, so the fetch is reproducible.
{ fetchurl, model ? "small" }:

let
  rev = "5359861c739e955e79d9a303bcbc70fb988958b1";
  hashes = {
    "small" = "sha256-G+OpsgY4Z7k35k4ux0gzZKeZF+FX+pjF2UtcH//qmHs=";
    "large-v3-turbo-q5_0" = "sha256-OUIhcJzVrR9AxG5gMcphvOiJMebgiMGIKUxtWlX/p+I=";
  };
in
fetchurl {
  name = "ggml-${model}.bin";
  url = "https://huggingface.co/ggerganov/whisper.cpp/resolve/${rev}/ggml-${model}.bin";
  hash = hashes.${model};
}
