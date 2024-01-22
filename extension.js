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

export default class ESP extends Extension.Extension {
    enable() {
        const Me = this;
        Me.Util = Util;
        Me.Util.init(Me);
        Me._ = this.gettext.bind(this);

        this._esp = new ExtensionsSearchProviderModule(Me);
        this._esp.update();

        console.debug(`${this.metadata.name}: enabled`);
    }

    disable() {
        this._esp.update(true);
        this._esp.cleanGlobals();
        this.Util.cleanGlobals();
        this.Util = null;
        this._esp = null;

        console.debug(`${this.metadata.name}: disabled`);
    }
}
