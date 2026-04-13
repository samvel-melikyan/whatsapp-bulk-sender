/**
 * Content script for WhatsApp Web button automation.
 */

console.log("WhatsApp Bulk Sender: Content script injected.");

// Listen for messages from the popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "SEND_MESSAGE") {
        console.log("WhatsApp Bulk Sender: Attempting to send message...");

        waitForSendButton()
            .then(() => {
                try { sendResponse({ status: "SUCCESS" }); } catch (e) { }
            })
            .catch((err) => {
                console.error(err);
                try { sendResponse({ status: "ERROR", message: err.message }); } catch (e) { }
            });

        return true; // Keep channel open for async response
    }
});

function waitForSendButton(retries = 30) {
    return new Promise((resolve, reject) => {
        let attempts = 0;

        const check = () => {
            attempts++;

            // Core logic: look for the send icon first
            let sendIcon = document.querySelector('span[data-icon="send"]');
            let sendBtn = null;

            if (sendIcon) {
                // The actual clickable element is usually a button or div wrapper
                sendBtn = sendIcon.closest('button') || sendIcon.closest('div[role="button"]') || sendIcon;
            } else {
                // Secondary fallbacks for WhatsApp DOM variations
                sendBtn = document.querySelector('button[aria-label="Send"]') ||
                    document.querySelector('button[data-testid="compose-btn-send"]') ||
                    document.querySelector('[data-testid="send"]');
            }

            if (sendBtn) {
                console.log("WhatsApp Bulk Sender: Send button found. Clicking...");

                // Focusing the composer helps trigger React's active state
                const composer = document.querySelector('div[contenteditable="true"]');
                if (composer) composer.focus();

                // Trigger natural click
                sendBtn.click();

                // Allow time for the send animation to dispatch before resolving
                setTimeout(() => resolve(), 1500);
            } else {
                // Detect invalid number popups to immediately skip wait
                const errPopup = document.querySelector('[data-testid="popup-controls"]');
                if (errPopup && document.body.innerText.toLowerCase().includes('invalid')) {
                    const okButton = errPopup.querySelector('button');
                    if (okButton) okButton.click();
                    return reject(new Error("Invalid number."));
                }

                if (attempts < retries) {
                    setTimeout(check, 1000);
                } else {
                    reject(new Error("Send button not found after 30 seconds."));
                }
            }
        };

        check();
    });
}
