/**
 * ESP (Extensions Search Provider)
 * extension.js
 *
 * @author     GdH <G-dH@github.com>
 * @copyright  2023 - 2024
 * @license    GPL-3.0
 *
 */

'use strict';

import * as Extension from 'resource:///org/gnome/shell/extensions/extension.js';

// Me imports
import { ExtensionsSearchProviderModule } from './extensionsSearchProvider.js';
import * as Util from './util.js';
// import * as Settings from './settings.js';

export default class ESP extends Extension.Extension {
    enable() {
        const Me = this;
        Me.Util = Util;
        Me.opt = null; // no settings yet
        Me.Util.init();
        Me._ = this.gettext.bind(this);
        this._esp = new ExtensionsSearchProviderModule(Me);
        this._esp.update();

        console.debug(`${this.metadata.name}: enabled`);
    }

    // Reason for using "unlock-dialog" session mode:
    // Updating the "appDisplay" content every time the screen is locked/unlocked takes quite a lot of time and affects the user experience.
    disable() {
        this._esp.update(true);
        this._esp.cleanGlobals();
        this.Util.cleanGlobals();
        this._esp = null;
        console.debug(`${this.metadata.name}: disabled`);
    }
}
