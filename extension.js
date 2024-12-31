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

import * as Extension from 'resource:///org/gnome/shell/extensions/extension.js';

// Me imports
import * as Settings from './settings.js';
import { ExtensionsSearchProviderModule } from './extensionsSearchProvider.js';
import * as Util from './util.js';


export default class ESP extends Extension.Extension {
    enable() {
        const Me = {};
        Me.providerId = 'extensions';
        // prefix helps to eliminate results from other search providers
        // this prefix is also used by the V-Shell to activate this provider
        Me.defaultPrefix = 'eq//';

        Me.getSettings = this.getSettings.bind(this);
        Me.metadata = this.metadata;
        Me.gSettings = this.getSettings();
        Me.Settings = Settings;
        Me.Util = Util;
        Me._ = this.gettext.bind(this);
        Me.opt = new Me.Settings.Options(Me);

        this.Me = Me;

        this._esp = new ExtensionsSearchProviderModule(Me);
        this._esp.update();

        console.debug(`${this.metadata.name}: enabled`);
    }

    disable() {
        this._esp.update(true);
        this._esp.cleanGlobals();
        this.Me.opt.destroy();
        this.Me.opt = null;
        this.Me.Util.cleanGlobals();
        this.Me = null;
        this._esp = null;

        console.debug(`${this.metadata.name}: disabled`);
    }
}
