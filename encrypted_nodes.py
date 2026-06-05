import io
import os
import platform
import re
import subprocess
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
_NUMBERED_NAME_RE = re.compile(r"^(?P<prefix>.+)_(?P<number>\d{3,})\.cimg$")


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


def _filename_sort_key(filename: str):
    """Sort encrypted images by their explicit number, then by name."""
    match = _NUMBERED_NAME_RE.match(filename)
    if match:
        return (0, int(match.group("number")), filename)

    return (1, filename)


def _list_encrypted_files():
    files = sorted(
        (path.name for path in OUTPUT_DIR.glob("*.cimg") if path.is_file()),
        key=_filename_sort_key,
    )
    return files or [""]


def _open_folder(path: Path):
    """Open a folder with the operating system file browser when available."""
    system = platform.system()
    if system == "Windows":
        os.startfile(path)
        return True, "Opened with Windows Explorer"

    if system == "Darwin":
        subprocess.Popen(["open", str(path)])
        return True, "Opened with Finder"

    # Hosted notebook environments (for example Kaggle) usually do not have a
    # graphical file manager or text browser. Avoid spawning xdg-open there: it
    # only prints noisy mailcap/browser errors and cannot show the remote folder.
    if not os.environ.get("DISPLAY") and not os.environ.get("WAYLAND_DISPLAY"):
        return False, "No graphical desktop is available; showing the in-browser gallery instead."

    try:
        process = subprocess.run(
            ["xdg-open", str(path)],
            check=False,
            capture_output=True,
            text=True,
            timeout=5,
        )
    except FileNotFoundError:
        return False, "xdg-open is not installed; showing the in-browser gallery instead."
    except subprocess.TimeoutExpired:
        return True, "Opening folder with xdg-open"

    if process.returncode == 0:
        return True, "Opened with xdg-open"

    error = (process.stderr or process.stdout or "xdg-open failed").strip()
    return False, f"Unable to open system folder: {error}"


def _next_encrypted_filename(prefix: str) -> str:
    """Return the next non-existing encrypted filename as prefix_001.cimg."""
    next_number = 1
    for path in OUTPUT_DIR.glob("*.cimg"):
        match = _NUMBERED_NAME_RE.match(path.name)
        if match:
            next_number = max(next_number, int(match.group("number")) + 1)

    while True:
        filename = f"{prefix}_{next_number:03}.cimg"
        if not _encrypted_path(filename).exists():
            return filename
        next_number += 1


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

        for image in images:
            png_bytes = _image_to_png_bytes(image)
            encrypted = xor_data(png_bytes, XOR_KEY)

            filename = _next_encrypted_filename(prefix)
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


@routes.get("/encrypted_images")
async def encrypted_images(request):
    return web.json_response({"files": _list_encrypted_files()})


@routes.post("/open_encrypted_folder")
async def open_encrypted_folder(request):
    try:
        ok, message = _open_folder(OUTPUT_DIR)
    except Exception as error:
        ok = False
        message = f"Unable to open encrypted image folder: {error}"

    return web.json_response(
        {
            "ok": ok,
            "message": message,
            "folder": str(OUTPUT_DIR),
            "files": _list_encrypted_files(),
        }
    )


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

    headers = {"Cache-Control": "no-store"}
    if request.rel_url.query.get("download"):
        download_name = f"{path.stem}.png"
        headers["Content-Disposition"] = f'attachment; filename="{download_name}"'

    return web.Response(
        body=decrypted,
        content_type="image/png",
        headers=headers,
    )


NODE_CLASS_MAPPINGS = {
    "SaveEncryptedImage": SaveEncryptedImage,
    "LoadEncryptedImagePreview": LoadEncryptedImagePreview,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "SaveEncryptedImage": "Save Encrypted Image",
    "LoadEncryptedImagePreview": "Load Encrypted Image Preview",
}
