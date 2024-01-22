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

const ExtensionUtils = imports.misc.extensionUtils;
const MyExtension = ExtensionUtils.getCurrentExtension();
const ExtensionsSearchProviderModule = MyExtension.imports.extensionsSearchProvider.ExtensionsSearchProviderModule;
const Util = MyExtension.imports.util;

function init() {
    ExtensionUtils.initTranslations();
    return new ESP();
}

class ESP {
    enable() {
        const Me = MyExtension;
        this.Util = Util;
        this.Util.init(Me);
        this.gettext = imports.gettext.domain(Me.metadata['gettext-domain']).gettext;
        this._ = Me.gettext;

        this._esp = new ExtensionsSearchProviderModule(this);
        this._esp.update();

        console.debug(`${MyExtension.metadata.name}: enabled`);
    }

    disable() {
        this._esp.update(true);
        this._esp.cleanGlobals();
        this.Util.cleanGlobals();
        this.Util = null;
        this._esp = null;

        console.debug(`${MyExtension.metadata.name}: disabled`);
    }
}
