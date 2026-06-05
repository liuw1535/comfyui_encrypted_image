import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const ENCRYPTED_NODE_TYPES = ["SaveEncryptedImage", "LoadEncryptedImagePreview"];
const LOAD_NODE_TYPE = "LoadEncryptedImagePreview";

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

function setNodePreview(node, images) {
    node.images = images.map((img) => {
        const image = new Image();
        image.src = `${encryptedViewUrl(img.filename)}&t=${Date.now()}`;
        return image;
    });
    app.graph.setDirtyCanvas(true);
}

async function getEncryptedFiles() {
    const response = await api.fetchApi("/encrypted_images");
    if (!response.ok) {
        throw new Error(await response.text());
    }

    const data = await response.json();
    return data.files?.length ? data.files : [""];
}

async function refreshEncryptedFiles(node, selectFirst = false) {
    const widget = getFilenameWidget(node);
    if (!widget) {
        return;
    }

    const previous = widget.value;
    const values = await getEncryptedFiles();
    widget.options.values = values;

    if (selectFirst || !values.includes(previous)) {
        widget.value = values[0] || "";
    } else {
        widget.value = previous;
    }

    updateLoadNodePreview(node);
    app.graph.setDirtyCanvas(true);
}

function updateLoadNodePreview(node) {
    const filename = currentFilename(node);
    if (!filename) {
        node.images = [];
    } else {
        setNodePreview(node, [{ filename }]);
    }
}

async function openEncryptedFolder() {
    const response = await api.fetchApi("/open_encrypted_folder", { method: "POST" });
    if (!response.ok) {
        throw new Error(await response.text());
    }
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
                await refreshEncryptedFiles(this, false);
            });
            this.addWidget("button", "open folder", null, async () => {
                await openEncryptedFolder();
            });
            this.addWidget("button", "download", null, () => {
                downloadCurrentImage(this);
            });
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
