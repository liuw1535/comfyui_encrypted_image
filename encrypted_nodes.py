import os
import io
import json
import torch
import numpy as np

from PIL import Image
from aiohttp import web

import folder_paths
from server import PromptServer

OUTPUT_DIR = os.path.join(folder_paths.output_directory, "encrypted")

os.makedirs(OUTPUT_DIR, exist_ok=True)

XOR_KEY = b"my_secret_key"

def xor_data(data: bytes, key: bytes):
key_len = len(key)
return bytes([b ^ key[i % key_len] for i, b in enumerate(data)])

class SaveEncryptedImage:
@classmethod
def INPUT_TYPES(cls):
    return {
        "required": {
            "images": ("IMAGE",),
            "filename_prefix": ("STRING", {
                "default": "ENC"
            }),
        }
    }

RETURN_TYPES = ()
FUNCTION = "save_images"
OUTPUT_NODE = True
CATEGORY = "image/encrypted"

def save_images(self, images, filename_prefix="ENC"):

    results = []

    for batch_number, image in enumerate(images):

        i = 255. * image.cpu().numpy()

        img = Image.fromarray(
            np.clip(i, 0, 255).astype(np.uint8)
        )

        # PNG encode to memory
        buffer = io.BytesIO()
        img.save(buffer, format="PNG")

        png_bytes = buffer.getvalue()

        # XOR encrypt
        encrypted = xor_data(png_bytes, XOR_KEY)

        filename = f"{filename_prefix}_{batch_number}.cimg"

        full_path = os.path.join(OUTPUT_DIR, filename)

        with open(full_path, "wb") as f:
            f.write(encrypted)

        results.append({
            "filename": filename,
            "subfolder": "encrypted",
            "type": "encrypted"
        })

    return {
        "ui": {
            "encrypted_images": results
        }
    }


#

# API ROUTE

#

routes = PromptServer.instance.routes

@routes.get("/view_encrypted")
async def view_encrypted(request):

filename = request.rel_url.query.get("filename")

if not filename:
    return web.Response(status=400)

path = os.path.join(OUTPUT_DIR, filename)

if not os.path.exists(path):
    return web.Response(status=404)

with open(path, "rb") as f:
    encrypted = f.read()

decrypted = xor_data(encrypted, XOR_KEY)

return web.Response(
    body=decrypted,
    content_type="image/png",
    headers={
        "Cache-Control": "no-store"
    }
)

NODE_CLASS_MAPPINGS = {
"SaveEncryptedImage": SaveEncryptedImage
}

NODE_DISPLAY_NAME_MAPPINGS = {
"SaveEncryptedImage": "Save Encrypted Image"
}