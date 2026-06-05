import { app } from "../../scripts/app.js";

app.registerExtension({
    name: "EncryptedImagePreview",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (!["SaveEncryptedImage", "LoadEncryptedImagePreview"].includes(nodeData.name)) {
            return;
        }

        const onExecuted = nodeType.prototype.onExecuted;

        nodeType.prototype.onExecuted = function (message) {
            if (onExecuted) {
                onExecuted.apply(this, arguments);
            }

            if (!message.encrypted_images) {
                return;
            }

            this.images = message.encrypted_images.map((img) => {
                const image = new Image();
                image.src = `/view_encrypted?filename=${encodeURIComponent(img.filename)}`;
                return image;
            });

            app.graph.setDirtyCanvas(true);
        };
    },
});
