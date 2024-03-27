/**
 * ESP (Extensions Search Provider)
 * extension.js
 *
 * @author     GdH <G-dH@github.com>
 * @copyright  2024
 * @license    GPL-3.0
 *
 */

'use strict';

const GLib = imports.gi.GLib;
const Main = imports.ui.main;

const ExtensionUtils = imports.misc.extensionUtils;
const MyExtension = ExtensionUtils.getCurrentExtension();
const ExtensionsSearchProviderModule = MyExtension.imports.extensionsSearchProvider.ExtensionsSearchProviderModule;
const Settings = MyExtension.imports.settings;
const Util = MyExtension.imports.util;
const { ExtensionState } = imports.misc.extensionUtils;

let reorderingInProgress = false;
let itIsMe = false;
let reorderTime = 0;

function init() {
    ExtensionUtils.initTranslations();
    return new ESP();
}

class ESP {
    enable() {
        this.metadata = MyExtension.metadata;
        // Reorder extensions to prevent ESP from rebasing when disabling other extensions
        // also reorder V-Shell extension as its rebase hides the overview
        // This option is opt-in so the user can make informed decision
        // Recursion guards have been implemented
        // in case when something external breaks the extensionOrder during reordering (only similar extension can do this)

        // If reordering was successful, ESP is already enabled, so return
        if (this._reorderExtensions())
            return;

        this.Me = MyExtension;
        this.Me.gSettings = ExtensionUtils.getSettings(this.Me.metadata['settings-schema']);
        this.Me.Settings = Settings;
        this.Me.Util = Util;
        this.Me._ = imports.gettext.domain(this.Me.metadata['gettext-domain']).gettext;

        this.Me.opt = new this.Me.Settings.Options(this.Me);

        this._esp = new ExtensionsSearchProviderModule(this.Me);
        this._esp.update();

        console.debug(`${this.metadata.name}: enabled`);
    }

    disable() {
        if (this._esp) {
            this._esp.update(true);
            this._esp.cleanGlobals();
            this._esp = null;
        }
        if (this.Me) {
            this.Me.opt.destroy();
            this.Me.opt = null;
            this.Me.Util.cleanGlobals();
            this.Me = null;
        }

        console.debug(`${this.metadata.name}: disabled`);
    }

    _reorderExtensions() {
        // Main.overview._shown likely indicates that the extension is being enabled from another ESP
        if (Main.overview._shown)
            return false;

        // This function is called before initialization of Settings module
        const settings = ExtensionUtils.getSettings(this.metadata['settings-schema']);
        const reorderEnabled = settings.get_boolean('reorder-extensions');
        const extensionManager = Main.extensionManager;
        // If extension system is async (since GNOME 44), skip reordering
        if (extensionManager._callExtensionEnable.constructor.name === 'AsyncFunction' || !reorderEnabled)
            return false;

        // Let's find out whether the enable() has been called as a regular enabling, or as a part of the rebase cycle
        // We need the stack trace info to get the caller name
        let globalRebasingInProgress;
        let callerName;
        try {
            throw new Error();
        } catch (error) {
            // The caller is at index 2 (0 is the current function, 1 is our enable())
            callerName = error.stack.split('\n')[2].match(/^[^@]+/)[0];
            // callerName _callExtensionDisable means that this call is a part of rebasing and our reordering must be canceled
            globalRebasingInProgress = callerName === '_callExtensionDisable';
        }

        const callerNameOK = callerName === '_callExtensionEnable';
        // Cancel if our stack trace inspection wasn't successful and prevent any potential recursion
        if (!callerNameOK || globalRebasingInProgress || reorderingInProgress || (reorderTime && Date.now() - reorderTime < 1000)) {
            if (!(globalRebasingInProgress || itIsMe)) {
                console.warn(`${this.metadata.name}: Error: Reordering extensions has been canceled due to the unknown caller or detected recursion`);
                // Return true to cancel this unwanted call to enable()
                return true;
            }
            return false;
        }

        reorderingInProgress = true;
        reorderTime = Date.now();

        // Extensions that should be enabled
        const enabledExtensions = extensionManager._enabledExtensions;
        // Extensions already enabled, make a copy
        const extensionOrder = [...extensionManager._extensionOrder];
        // Reverse, so we can disable them in the right order
        const extensionOrderReversed = [...extensionOrder].reverse();

        // Find also development V-Shell, which has a different uuid with the same base
        let vShellUUID = null;
        for (const uuid of enabledExtensions) {
            if (uuid.includes('vertical-workspaces@G-dH.github.com')) {
                vShellUUID = uuid;
                break;
            }
        }

        // Find whether the list of already enabled extensions starts with multi-session ones
        // and remember index of the last one so we can skip disabling them
        let lastMultiSessionIndex = -1;
        for (let i = 0; i < extensionOrder.length; i++) {
            const uuid = extensionOrder[i];
            const extension = extensionManager.lookup(uuid);
            if (extension.sessionModes.length === 1)
                break;
            lastMultiSessionIndex += 1;
        }

        console.log(`[${this.metadata.name}]: Reordering ${extensionOrder.length - (lastMultiSessionIndex + 1)} already enabled extensions ...`);

        const multiSessionExtensions = [];
        for (const uuid of extensionOrderReversed) {
            const sessionModes = extensionManager.lookup(uuid).sessionModes.length;
            const index = extensionOrder.indexOf(uuid);
            // Disable all already enabled extensions
            // except for those with more session modes at the beginning of the list
            if (index > lastMultiSessionIndex) {
                console.log(`[${this.metadata.name}]:  Disabling ${uuid}`);
                this._callExtensionDisable(uuid);
                if (sessionModes > 1) {
                    // move the uuid to multi-session list
                    extensionOrder.splice(index, 1);
                    multiSessionExtensions.push(uuid);
                }
            } else { // just remove it from the list of extensions to re-enable
                extensionOrder.splice(index, 1);
            }
        }

        // If V-Shell should be enabled, but wasn't enabled before ESP, enable it here if possible
        // _callExtensionEnable will cancel it if V-Shell is already enabled
        if (vShellUUID)
            extensionManager._callExtensionEnable.bind(extensionManager)(vShellUUID);

        // Re-enable the previously disabled extensions
        // First multi-session ones
        for (const uuid of multiSessionExtensions) {
            console.log(`[${this.metadata.name}]:  Enabling ${uuid}`);
            this._callExtensionEnable(uuid);
        }

        // Enable ESP here. We are calling the same enable from enable, but it's handled
        // The extension manager will add ESP to _extensionOrder twice, but we will fix that later
        itIsMe = true; // Just to prevent recursion error log
        console.log(`[${this.metadata.name}]:  Enabling ${this.metadata.uuid}`);
        this._callExtensionEnable(this.metadata.uuid);
        itIsMe = false;

        // Re-enable the rest of the extensions
        for (const uuid of extensionOrder) {
            console.log(`[${this.metadata.name}]:  Enabling ${uuid}`);
            this._callExtensionEnable(uuid);
        }

        // Extension manager will add the ESP uuid once again, after the extensions that we re-enabled here
        // We have to wait until all extensions are enabled and then remove the secondary push
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            // Use reversed order as it's always complete
            // We added the ESP already, so +1
            const index = extensionOrderReversed.length + 1;
            let order = extensionManager._extensionOrder;

            // Ensure we have the right index
            if (order[index] === this.metadata.uuid)
                order = order.splice(index, 1);
            else // This error indicates error in this function and should never be needed in the final version
                console.error(`${this.metadata.name}: The duplicate ESP uuid was not found on the expected position in the _extensionOrder, something has failed...`);

            // Reorder enabled-extensions key since its order is followed while unlocking screen or reenabling user-extensions
            const enabledExtensionsKey = global.settings.get_strv('enabled-extensions');
            enabledExtensionsKey.sort((a, b) => (b.includes(this.metadata.uuid) && a !== vShellUUID && enabledExtensionsKey.indexOf(b) > enabledExtensionsKey.indexOf(a)) || b === vShellUUID);
            // Move extensions supporting more session modes at the beginning
            // to minimize unnecessary disable/enable cycles during the first screen lock/unlock (default from GS 46)
            enabledExtensionsKey.sort((a, b) => {
                const sessionModesA = extensionManager.lookup(a)?.sessionModes || [];
                const sessionModesB = extensionManager.lookup(b)?.sessionModes || [];
                return sessionModesA < sessionModesB;
            });
            global.settings.set_strv('enabled-extensions', enabledExtensionsKey);
            return GLib.SOURCE_REMOVE;
        });

        reorderingInProgress = false;
        return true;
    }

    _callExtensionEnable(uuid) {
        try {
            Main.extensionManager.lookup(uuid).stateObj.enable();
        } catch (e) {
            Main.extensionManager.logExtensionError.bind(Main.extensionManager)(uuid, e);
        }
        Main.extensionManager._extensionOrder.push(uuid);
    }

    _callExtensionDisable(uuid) {
        try {
            Main.extensionManager.lookup(uuid).stateObj.disable();
        } catch (e) {
            Main.extensionManager.logExtensionError.bind(Main.extensionManager)(uuid, e);
        }
        Main.extensionManager._extensionOrder.pop();
    }
}
