import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const ENCRYPTED_NODE_TYPES = ["SaveEncryptedImage", "LoadEncryptedImagePreview"];
const LOAD_NODE_TYPE = "LoadEncryptedImagePreview";
const STYLE_ID = "encrypted-image-preview-style";
const AUTO_REFRESH_POLL_INTERVAL_MS = 5000;

function encryptedViewUrl(filename, download = false) {
    const params = new URLSearchParams({ filename });
    if (download) {
        params.set("download", "1");
    }
    return `/view_encrypted?${params.toString()}`;
}

function getFilenameWidget(node) {
    return node.widgets?.find((widget) => widget.name === "filename");
}

function currentFilename(node) {
    const widget = getFilenameWidget(node);
    return widget?.value || "";
}

function getNumericSuffix(filename) {
    const match = filename.match(/_(\d{3,})\.cimg$/i);
    return match ? Number.parseInt(match[1], 10) : Number.NEGATIVE_INFINITY;
}

function latestEncryptedFilename(files) {
    const candidates = files.filter(Boolean);
    if (!candidates.length) {
        return "";
    }

    return candidates.reduce((latest, filename) => {
        const latestNumber = getNumericSuffix(latest);
        const currentNumber = getNumericSuffix(filename);
        if (currentNumber !== latestNumber) {
            return currentNumber > latestNumber ? filename : latest;
        }

        return filename.localeCompare(latest, undefined, { numeric: true }) > 0 ? filename : latest;
    }, candidates[0]);
}

function redrawCanvas() {
    app.graph?.setDirtyCanvas(true, true);
}

function setNodePreview(node, images) {
    const loadedImages = images.map((img) => {
        const image = new Image();
        image.onload = redrawCanvas;
        image.onerror = redrawCanvas;
        image.src = `${encryptedViewUrl(img.filename)}&t=${Date.now()}`;
        return image;
    });

    // ComfyUI has used both `imgs` and `images` in different preview paths.
    // Setting both keeps decrypted previews visible across frontend versions.
    node.imgs = loadedImages;
    node.images = loadedImages;
    redrawCanvas();
}

async function getEncryptedFileSnapshot() {
    const response = await api.fetchApi("/encrypted_images");
    if (!response.ok) {
        throw new Error(await response.text());
    }

    const data = await response.json();
    return {
        files: data.files?.length ? data.files : [""],
        signature: data.signature ?? "",
    };
}

async function getEncryptedFiles() {
    return (await getEncryptedFileSnapshot()).files;
}

async function refreshEncryptedFiles(node, selectLatest = false, forcePreview = false) {
    const widget = getFilenameWidget(node);
    if (!widget) {
        return null;
    }

    const previous = widget.value;
    const snapshot = await getEncryptedFileSnapshot();
    const values = snapshot.files;
    if (node.encryptedDirectorySignature !== undefined) {
        node.encryptedDirectorySignature = snapshot.signature;
    }
    widget.options.values = values;

    if (selectLatest || !values.includes(previous)) {
        widget.value = latestEncryptedFilename(values);
    } else {
        widget.value = previous;
    }

    if (forcePreview || widget.value !== previous) {
        updateLoadNodePreview(node);
    }
    redrawCanvas();
    return snapshot;
}

function stopAutoRefresh(node) {
    if (node.encryptedAutoRefreshTimer) {
        clearTimeout(node.encryptedAutoRefreshTimer);
        node.encryptedAutoRefreshTimer = null;
    }
}

function disableAutoRefresh(node) {
    stopAutoRefresh(node);
    const widget = node.widgets?.find((item) => item.name === "auto refresh");
    if (widget) {
        widget.value = false;
    }
}

async function checkEncryptedDirectory(node) {
    const snapshot = await getEncryptedFileSnapshot();
    if (node.encryptedDirectorySignature === undefined) {
        node.encryptedDirectorySignature = snapshot.signature;
        return;
    }

    if (snapshot.signature === node.encryptedDirectorySignature) {
        return;
    }

    node.encryptedDirectorySignature = snapshot.signature;
    await refreshEncryptedFiles(node, true, true);
}

function scheduleAutoRefresh(node) {
    node.encryptedAutoRefreshTimer = setTimeout(async () => {
        node.encryptedAutoRefreshTimer = null;
        try {
            await checkEncryptedDirectory(node);
        } catch (error) {
            console.error("Encrypted image auto refresh failed", error);
            disableAutoRefresh(node);
            return;
        }

        const widget = node.widgets?.find((item) => item.name === "auto refresh");
        if (widget?.value) {
            scheduleAutoRefresh(node);
        }
    }, AUTO_REFRESH_POLL_INTERVAL_MS);
}

async function setAutoRefresh(node, enabled) {
    stopAutoRefresh(node);
    if (!enabled) {
        return;
    }

    node.encryptedDirectorySignature = undefined;
    try {
        await checkEncryptedDirectory(node);
    } catch (error) {
        console.error("Encrypted image auto refresh failed", error);
        disableAutoRefresh(node);
        return;
    }
    scheduleAutoRefresh(node);
}

function updateLoadNodePreview(node) {
    const filename = currentFilename(node);
    if (!filename) {
        node.imgs = [];
        node.images = [];
        redrawCanvas();
    } else {
        setNodePreview(node, [{ filename }]);
    }
}

function ensureGalleryStyles() {
    if (document.getElementById(STYLE_ID)) {
        return;
    }

    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
        .encrypted-gallery-backdrop {
            position: fixed;
            inset: 0;
            z-index: 10000;
            display: flex;
            align-items: center;
            justify-content: center;
            background: rgba(0, 0, 0, 0.65);
        }
        .encrypted-gallery {
            box-sizing: border-box;
            width: min(980px, calc(100vw - 48px));
            max-height: min(760px, calc(100vh - 48px));
            overflow: hidden;
            display: flex;
            flex-direction: column;
            gap: 12px;
            padding: 16px;
            color: var(--input-text, #ddd);
            background: var(--comfy-menu-bg, #252525);
            border: 1px solid var(--border-color, #555);
            border-radius: 10px;
            box-shadow: 0 12px 40px rgba(0, 0, 0, 0.45);
        }
        .encrypted-gallery header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 16px;
        }
        .encrypted-gallery h3 {
            margin: 0;
            font-size: 18px;
        }
        .encrypted-gallery .encrypted-gallery-close {
            cursor: pointer;
            border: 1px solid var(--border-color, #666);
            border-radius: 6px;
            padding: 6px 10px;
            color: inherit;
            background: var(--comfy-input-bg, #333);
        }
        .encrypted-gallery-grid {
            overflow: auto;
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
            gap: 12px;
            padding-right: 4px;
        }
        .encrypted-gallery-card {
            display: flex;
            flex-direction: column;
            gap: 8px;
            padding: 10px;
            background: rgba(255, 255, 255, 0.04);
            border: 1px solid var(--border-color, #444);
            border-radius: 8px;
        }
        .encrypted-gallery-card img {
            width: 100%;
            height: 150px;
            object-fit: contain;
            background: rgba(0, 0, 0, 0.25);
            border-radius: 4px;
        }
        .encrypted-gallery-filename {
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            font-size: 12px;
        }
        .encrypted-gallery-actions {
            display: flex;
            gap: 8px;
        }
        .encrypted-gallery-actions button,
        .encrypted-gallery-actions a {
            flex: 1;
            cursor: pointer;
            text-align: center;
            text-decoration: none;
            border: 1px solid var(--border-color, #666);
            border-radius: 5px;
            padding: 5px;
            color: inherit;
            background: var(--comfy-input-bg, #333);
            font-size: 12px;
        }
        .encrypted-gallery-empty {
            padding: 24px;
            text-align: center;
            opacity: 0.75;
        }
    `;
    document.head.appendChild(style);
}

function closeGallery(backdrop) {
    backdrop.remove();
    document.removeEventListener("keydown", backdrop._encryptedKeyHandler);
}

async function showEncryptedGallery(node) {
    ensureGalleryStyles();
    const files = (await getEncryptedFiles()).filter(Boolean);

    const backdrop = document.createElement("div");
    backdrop.className = "encrypted-gallery-backdrop";

    const modal = document.createElement("div");
    modal.className = "encrypted-gallery";
    backdrop.appendChild(modal);

    const header = document.createElement("header");
    const title = document.createElement("h3");
    title.textContent = `Encrypted images (${files.length})`;
    const closeButton = document.createElement("button");
    closeButton.className = "encrypted-gallery-close";
    closeButton.textContent = "Close";
    closeButton.addEventListener("click", () => closeGallery(backdrop));
    header.append(title, closeButton);
    modal.appendChild(header);

    const grid = document.createElement("div");
    grid.className = "encrypted-gallery-grid";
    modal.appendChild(grid);

    if (!files.length) {
        const empty = document.createElement("div");
        empty.className = "encrypted-gallery-empty";
        empty.textContent = "No encrypted images have been saved yet.";
        grid.appendChild(empty);
    }

    for (const filename of files) {
        const card = document.createElement("div");
        card.className = "encrypted-gallery-card";

        const image = document.createElement("img");
        image.loading = "lazy";
        image.src = `${encryptedViewUrl(filename)}&t=${Date.now()}`;

        const label = document.createElement("div");
        label.className = "encrypted-gallery-filename";
        label.title = filename;
        label.textContent = filename;

        const actions = document.createElement("div");
        actions.className = "encrypted-gallery-actions";

        const selectButton = document.createElement("button");
        selectButton.textContent = "Select";
        selectButton.addEventListener("click", () => {
            const widget = getFilenameWidget(node);
            if (widget) {
                widget.value = filename;
                updateLoadNodePreview(node);
                widget.callback?.(filename);
            }
            closeGallery(backdrop);
        });

        const downloadLink = document.createElement("a");
        downloadLink.href = encryptedViewUrl(filename, true);
        downloadLink.download = filename.replace(/\.cimg$/i, ".png");
        downloadLink.textContent = "Download";

        actions.append(selectButton, downloadLink);
        card.append(image, label, actions);
        grid.appendChild(card);
    }

    backdrop.addEventListener("click", (event) => {
        if (event.target === backdrop) {
            closeGallery(backdrop);
        }
    });
    backdrop._encryptedKeyHandler = (event) => {
        if (event.key === "Escape") {
            closeGallery(backdrop);
        }
    };
    document.addEventListener("keydown", backdrop._encryptedKeyHandler);
    document.body.appendChild(backdrop);
}

async function openEncryptedFolder() {
    const response = await api.fetchApi("/open_encrypted_folder", { method: "POST" });
    if (!response.ok) {
        throw new Error(await response.text());
    }
    return response.json();
}

function downloadCurrentImage(node) {
    const filename = currentFilename(node);
    if (!filename) {
        return;
    }

    const link = document.createElement("a");
    link.href = encryptedViewUrl(filename, true);
    link.download = filename.replace(/\.cimg$/i, ".png");
    document.body.appendChild(link);
    link.click();
    link.remove();
}

app.registerExtension({
    name: "EncryptedImagePreview",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (!ENCRYPTED_NODE_TYPES.includes(nodeData.name)) {
            return;
        }

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        const onExecuted = nodeType.prototype.onExecuted;
        const onRemoved = nodeType.prototype.onRemoved;

        nodeType.prototype.onNodeCreated = function () {
            onNodeCreated?.apply(this, arguments);

            if (nodeData.name !== LOAD_NODE_TYPE) {
                return;
            }

            const filenameWidget = getFilenameWidget(this);
            if (filenameWidget) {
                const callback = filenameWidget.callback;
                filenameWidget.callback = (...args) => {
                    callback?.apply(filenameWidget, args);
                    updateLoadNodePreview(this);
                };
                updateLoadNodePreview(this);
            }

            this.addWidget("button", "refresh", null, async () => {
                await refreshEncryptedFiles(this, true, true);
            });
            this.addWidget("toggle", "auto refresh", false, (enabled) => {
                setAutoRefresh(this, Boolean(enabled));
            });
            this.addWidget("button", "show folder", null, async () => {
                await showEncryptedGallery(this);
            });
            this.addWidget("button", "open system folder", null, async () => {
                const result = await openEncryptedFolder();
                if (result && result.ok === false) {
                    await showEncryptedGallery(this);
                }
            });
            this.addWidget("button", "download", null, () => {
                downloadCurrentImage(this);
            });
        };

        nodeType.prototype.onRemoved = function () {
            stopAutoRefresh(this);
            onRemoved?.apply(this, arguments);
        };

        nodeType.prototype.onExecuted = function (message) {
            onExecuted?.apply(this, arguments);

            if (!message.encrypted_images) {
                return;
            }

            setNodePreview(this, message.encrypted_images);
        };
    },
});
