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
        const Me = MyExtension;
        Me.providerId = 'extensions';
        // prefix helps to eliminate results from other search providers
        // this prefix is also used by the V-Shell to activate this provider
        Me.defaultPrefix = 'eq//';

        Me.shellVersion = parseFloat(imports.misc.config.PACKAGE_VERSION);
        Me.gSettings = ExtensionUtils.getSettings(Me.metadata['settings-schema']);
        Me.Settings = Settings;
        Me.Util = Util;
        Me._ = imports.gettext.domain(Me.metadata['gettext-domain']).gettext;
        Me.opt = new Me.Settings.Options(Me);

        this._esp = new ExtensionsSearchProviderModule(Me);
        this._esp.update();

        this.Me = Me;
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
    }
}
