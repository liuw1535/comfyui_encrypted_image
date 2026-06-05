import io
import re
from pathlib import Path

import numpy as np

from PIL import Image
from aiohttp import web

import folder_paths
from server import PromptServer

OUTPUT_DIR = Path(folder_paths.output_directory) / "encrypted"
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

XOR_KEY = b"my_secret_key"
_SAFE_NAME_RE = re.compile(r"[^A-Za-z0-9_.-]+")


def xor_data(data: bytes, key: bytes) -> bytes:
    """Return data XORed with the repeated key."""
    if not key:
        raise ValueError("XOR key must not be empty")

    key_len = len(key)
    return bytes(byte ^ key[index % key_len] for index, byte in enumerate(data))


def _safe_component(value: str, default: str = "ENC") -> str:
    """Sanitize a single filename component without allowing path traversal."""
    cleaned = _SAFE_NAME_RE.sub("_", Path(value).name).strip("._")
    return cleaned or default


def _encrypted_path(filename: str) -> Path:
    """Resolve a .cimg file path and ensure it stays inside OUTPUT_DIR."""
    safe_filename = Path(filename).name
    if safe_filename != filename:
        raise ValueError("Invalid encrypted image filename")

    path = (OUTPUT_DIR / safe_filename).resolve()
    output_dir = OUTPUT_DIR.resolve()

    if path.parent != output_dir or path.suffix != ".cimg":
        raise ValueError("Invalid encrypted image filename")

    return path


def _list_encrypted_files():
    files = sorted(path.name for path in OUTPUT_DIR.glob("*.cimg") if path.is_file())
    return files or [""]


def _next_encrypted_filename(prefix: str, batch_number: int) -> str:
    """Return a non-existing encrypted filename for the current batch item."""
    counter = 0
    while True:
        suffix = f"_{counter:05}" if counter else ""
        filename = f"{prefix}_{batch_number}{suffix}.cimg"
        if not _encrypted_path(filename).exists():
            return filename
        counter += 1


def _image_to_png_bytes(image) -> bytes:
    pixels = 255.0 * image.cpu().numpy()
    pil_image = Image.fromarray(np.clip(pixels, 0, 255).astype(np.uint8))

    buffer = io.BytesIO()
    pil_image.save(buffer, format="PNG")
    return buffer.getvalue()


class SaveEncryptedImage:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": ("IMAGE",),
                "filename_prefix": ("STRING", {"default": "ENC"}),
            }
        }

    RETURN_TYPES = ()
    FUNCTION = "save_images"
    OUTPUT_NODE = True
    CATEGORY = "image/encrypted"

    def save_images(self, images, filename_prefix="ENC"):
        results = []
        prefix = _safe_component(filename_prefix)

        for batch_number, image in enumerate(images):
            png_bytes = _image_to_png_bytes(image)
            encrypted = xor_data(png_bytes, XOR_KEY)

            filename = _next_encrypted_filename(prefix, batch_number)
            path = _encrypted_path(filename)

            with path.open("xb") as file:
                file.write(encrypted)

            results.append({"filename": filename, "subfolder": "encrypted", "type": "encrypted"})

        return {"ui": {"encrypted_images": results}}


class LoadEncryptedImagePreview:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "filename": (_list_encrypted_files(),),
            }
        }

    RETURN_TYPES = ()
    FUNCTION = "load_image"
    OUTPUT_NODE = True
    CATEGORY = "image/encrypted"

    def load_image(self, filename):
        if not filename:
            return {"ui": {"encrypted_images": []}}

        path = _encrypted_path(filename)
        if not path.exists():
            raise FileNotFoundError(f"Encrypted image not found: {filename}")

        return {
            "ui": {
                "encrypted_images": [
                    {"filename": path.name, "subfolder": "encrypted", "type": "encrypted"}
                ]
            }
        }


routes = PromptServer.instance.routes


@routes.get("/view_encrypted")
async def view_encrypted(request):
    filename = request.rel_url.query.get("filename")
    if not filename:
        return web.Response(status=400, text="Missing filename")

    try:
        path = _encrypted_path(filename)
    except ValueError as error:
        return web.Response(status=400, text=str(error))

    if not path.exists():
        return web.Response(status=404, text="Encrypted image not found")

    encrypted = path.read_bytes()
    decrypted = xor_data(encrypted, XOR_KEY)

    return web.Response(
        body=decrypted,
        content_type="image/png",
        headers={"Cache-Control": "no-store"},
    )


NODE_CLASS_MAPPINGS = {
    "SaveEncryptedImage": SaveEncryptedImage,
    "LoadEncryptedImagePreview": LoadEncryptedImagePreview,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "SaveEncryptedImage": "Save Encrypted Image",
    "LoadEncryptedImagePreview": "Load Encrypted Image Preview",
}
