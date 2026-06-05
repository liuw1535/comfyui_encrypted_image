app.registerExtension({
name: "EncryptedImagePreview",

async beforeRegisterNodeDef(nodeType, nodeData, app) {

    if (nodeData.name === "SaveEncryptedImage") {

        const onExecuted = nodeType.prototype.onExecuted;

        nodeType.prototype.onExecuted = function(message) {

            if (onExecuted) {
                onExecuted.apply(this, arguments);
            }

            if (!message.encrypted_images) {
                return;
            }

            this.images = [];

            for (const img of message.encrypted_images) {

                const image = new Image();

                image.src =
                    `/view_encrypted?filename=${encodeURIComponent(img.filename)}`;

                this.images.push(image);
            }

            app.graph.setDirtyCanvas(true);
        };
    }
}

});