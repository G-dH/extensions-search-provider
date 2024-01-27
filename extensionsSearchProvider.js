/**
 * ESP (Extensions Search Provider)
 * extensionsSearchProvider.js
 *
 * @author     GdH <G-dH@github.com>
 * @copyright  2023 - 2024
 * @license    GPL-3.0
 */

'use strict';

const  { GLib, St, Gio, GObject, Clutter, Shell } = imports.gi;

const Main = imports.ui.main;

const ExtensionState = {
    1: 'ENABLED',
    2: 'DISABLED',
    3: 'ERROR',
    4: 'INCOMPATIBLE',
    5: 'DOWNLOADING',
    6: 'INITIALIZED',
    7: 'DISABLING',
    8: 'ENABLING',
};

let Me;
let opt;
// gettext
let _;
let _toggleTimeout;

// prefix helps to eliminate results from other search providers
// so it needs to be something less common
const PREFIX = 'eq//';

var ExtensionsSearchProviderModule = class {
    constructor(me) {
        Me = me;
        opt = Me.opt;
        _  = Me._;

        this._firstActivation = true;
        this.moduleEnabled = false;
        this._extensionsSearchProvider = null;
        this._enableTimeoutId = 0;
    }

    cleanGlobals() {
        Me = null;
        opt = null;
        _ = null;
    }

    update(reset) {
        if (_toggleTimeout) {
            GLib.source_remove(_toggleTimeout);
            _toggleTimeout = 0;
        }

        if (reset)
            this._disableModule();
        else if (!reset)
            this._activateModule();
    }

    _activateModule() {
        // GNOME 43/44 has a problem registering a new provider during Shell's startup
        let delay = 0;
        if (Main.layoutManager._startingUp)
            delay = 2000;
        this._enableTimeoutId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            delay,
            () => {
                if (!this._extensionsSearchProvider) {
                    this._extensionsSearchProvider = new extensionsSearchProvider(opt);
                    this._getOverviewSearchResult()._registerProvider(this._extensionsSearchProvider);
                }
                this._enableTimeoutId = 0;
                return GLib.SOURCE_REMOVE;
            }
        );

        // In case the extension has been rebased after disabling another extension,
        // update the search results view so the user don't lose the context
        if (Main.overview._shown && Main.overview.searchEntry.text) {
            const text = Main.overview.searchEntry.text;
            Main.overview.searchEntry.text = 'eq///';
            GLib.idle_add(GLib.PRIORITY_LOW,
                () => {
                    Main.overview.searchEntry.text = text;
                });
        }

        console.debug('  ExtensionsSearchProviderModule - Activated');
    }

    _disableModule() {
        if (this._enableTimeoutId) {
            GLib.source_remove(this._enableTimeoutId);
            this._enableTimeoutId = 0;
        }
        if (this._extensionsSearchProvider) {
            this._getOverviewSearchResult()._unregisterProvider(this._extensionsSearchProvider);
            this._extensionsSearchProvider = null;
        }

        console.debug('  ExtensionsSearchProviderModule - Disabled');
    }

    _getOverviewSearchResult() {
        return Main.overview._overview.controls._searchController._searchResults;
    }
};

class extensionsSearchProvider {
    constructor() {
        this.id = 'extensions';
        const appSystem = Shell.AppSystem.get_default();

        let appInfo = appSystem.lookup_app('org.gnome.Extensions.desktop')?.get_app_info();
        if (!appInfo)
            appInfo = appSystem.lookup_app('com.matjakeman.ExtensionManager.desktop')?.get_app_info();
        if (!appInfo) {
            appInfo = Gio.AppInfo.create_from_commandline('/usr/bin/gnome-extensions-app', 'Extensions', null);
            appInfo.get_name = () => _('Extensions');
            appInfo.get_id = () => 'org.gnome.Extensions.desktop';
            appInfo.get_icon = () => Gio.icon_new_for_string('application-x-addon');
            appInfo.get_description = () => _('Search extensions');
            appInfo.should_show = () => true;
        }

        this.appInfo = appInfo;
        this.canLaunchSearch = true;
        this.isRemoteProvider = false;
    }

    getInitialResultSet(terms, callback, cancelable) {
        const extensions = {};
        Main.extensionManager._extensions.forEach(
            e => {
                extensions[e.uuid] = e;
            }
        );
        this.extensions = extensions;

        // In GS 43 callback arg has been removed
        if (cancelable === undefined) {
            return new Promise(resolve => resolve(this._getResultSet(terms)));
        } else {
            callback(this._getResultSet(terms));
            return null;
        }
    }

    _getResultSet(terms) {
        const prefixes = [PREFIX];
        prefixes.push(...opt.CUSTOM_PREFIXES);

        let prefix;
        for (let p of prefixes) {
            p = new RegExp(`^${p}`, 'i');
            if (p.test(terms[0])) {
                prefix = p;
                break;
            }
        }

        if (!prefix && opt.EXCLUDE_FROM_GLOBAL_SEARCH)
            return new Map();

        this._listAllResults = !!prefix;

        // do not modify original terms
        let termsCopy = [...terms];
        // search for terms without prefix
        termsCopy[0] = termsCopy[0].replace(prefix, '');

        const candidates = this.extensions;
        const _terms = [].concat(termsCopy);

        const term = _terms.join(' ').trim();

        let results = [];
        let m;
        for (let id in candidates) {
            const extension = this.extensions[id];
            const text = extension.metadata.name + (extension.state === 1 ? 'enabled' : '') + ([6, 2].includes(extension.state) ? 'disabled' : '');
            if (opt.FUZZY)
                m = Me.Util.fuzzyMatch(term, text);
            else
                m = Me.Util.strictMatch(term, text);

            if (m !== -1)
                results.push({ weight: m, id });
        }

        // filter out incompatible
        const hideIncompatible = !opt.SHOW_INCOMPATIBLE || (!prefix && opt.INCOMPATIBLE_HIDE_GLOBAL) || (term && opt.INCOMPATIBLE_FULL_ONLY);
        if (hideIncompatible)
            results = results.filter(e => this.extensions[e.id].state !== 4);

        // sort alphabetically
        results.sort((a, b) => this.extensions[a.id].metadata.name.localeCompare(this.extensions[b.id].metadata.name));

        // enabled first
        if (opt.ENABLED_FIRST)
            results.sort((a, b) => this.extensions[a.id].state !== 1 && this.extensions[b.id].state === 1);

        // incompatible last
        if (!hideIncompatible && opt.INCOMPATIBLE_LAST)
            results.sort((a, b) => this.extensions[a.id].state === 4 && this.extensions[b.id].state !== 4);

        const resultIds = results.map(item => item.id);
        return resultIds;
    }

    getResultMetas(resultIds, callback, cancalable) {
        const metas = resultIds.map(id => this.getResultMeta(id));
        if (cancalable === undefined)
            return new Promise(resolve => resolve(metas));
        else if (callback)
            callback(metas);
        return null;
    }

    getResultMeta(resultId) {
        const result = this.extensions[resultId];

        const versionName = result.metadata['version-name'] ?? '';
        let version = result.metadata['version'] ?? '';
        version = versionName && version ? `/${version}` : version;
        const versionStr = `${versionName}${version}`;

        return {
            'id': resultId,
            'name': `${result.metadata.name}`,
            'version': versionStr,
            'description': versionStr, // description will be updated in result object
            'createIcon': size => {
                let icon = this.getIcon(result, size);
                return icon;
            },
        };
    }

    getIcon(extension, size) {
        let opacity = 0;
        let iconName = 'process-stop-symbolic';

        switch (extension.state) {
        case 1:
            if (extension.hasUpdate)
                iconName = 'software-update-available'; // 'software-update-available-symbolic';
            else
                iconName = 'object-select-symbolic';// 'object-select-symbolic';

            opacity = 255;
            break;
        case 3:
            if (Main.extensionManager._enabledExtensions.includes(extension.uuid))
                iconName = 'emblem-ok-symbolic';
            else
                iconName = 'dialog-error';
            opacity = 180;
            break;
        case 4:
            iconName = 'software-update-urgent'; // 'software-update-urgent-symbolic';
            opacity = 180;
            break;
        }

        if (extension.hasUpdate) {
            iconName = 'software-update-available'; // 'software-update-available-symbolic';
            opacity = 180;
        }

        const icon = new St.Icon({ icon_name: iconName, icon_size: size });
        icon.set({
            opacity,
        });

        return icon;
    }

    createResultObject(meta) {
        const lsr = new ListSearchResult(this, meta, this.extensions[meta.id]);
        this.extensions[meta.id]['toggleExtension'] = lsr._toggleExtension.bind(lsr);
        return lsr;
    }

    launchSearch(terms, timeStamp) {
        if (this._listAllResults) {
            // launch Extensions app
            this.appInfo.launch([], global.create_app_launch_context(timeStamp, -1), null);
        } else {
            // update search so all results will be listed
            Main.overview._overview._controls._searchController._searchResults._reset();
            Main.overview._overview.controls._searchEntry.set_text(`${PREFIX} ${terms}`);
            // cause an error so the overview will stay open
            this.dummyError();
        }
    }

    activateResult(resultId/* terms, timeStamp*/) {
        const extension = this.extensions[resultId];
        if (Me.Util.isShiftPressed())
            this.extensions[resultId].toggleExtension(extension);
        else if (extension.hasPrefs)
            Me.Util.openPreferences(extension.metadata);
    }

    filterResults(results, maxResults) {
        return this._listAllResults
            ? results
            : results.slice(0, maxResults);
    }

    getSubsearchResultSet(previousResults, terms, callback) {
        if (!callback) {
            return this.getInitialResultSet(terms);
        } else {
            callback(this._getResultSet(terms));
            return null;
        }
    }
}

const ListSearchResult = GObject.registerClass(
class ListSearchResult extends St.Button {
    _init(provider, metaInfo, extension) {
        this.provider = provider;
        this.metaInfo = metaInfo;
        this.extension = extension;

        super._init({
            reactive: true,
            can_focus: true,
            track_hover: true,
        });

        this.style_class = 'list-search-result';

        let content = new St.BoxLayout({
            style_class: 'list-search-result-content',
            vertical: false,
            x_align: Clutter.ActorAlign.START,
            x_expand: true,
            y_expand: true,
        });
        this.set_child(content);

        let titleBox = new St.BoxLayout({
            style_class: 'list-search-result-title',
            y_align: Clutter.ActorAlign.CENTER,
        });

        content.add_child(titleBox);

        // An icon for, or thumbnail of, content
        let icon = this.metaInfo['createIcon'](this.ICON_SIZE);
        let iconBox = new St.Button();
        iconBox.set_child(icon);
        titleBox.add_child(iconBox);
        iconBox.set_style('border: 1px solid rgba(200,200,200,0.2); padding: 2px; border-radius: 8px;');
        this._iconBox = iconBox;
        this.icon = icon;

        iconBox.connect('button-press-event', () => {
            this._toggleExtension();
            return Clutter.EVENT_STOP;
        });

        let title = new St.Label({
            text: this.metaInfo['name'],
            y_align: Clutter.ActorAlign.CENTER,
            opacity: extension.hasPrefs ? 255 : 150,
        });
        titleBox.add_child(title);

        this.label_actor = title;

        this._descriptionLabel = new St.Label({
            style_class: 'list-search-result-description',
            y_align: Clutter.ActorAlign.CENTER,
        });
        content.add_child(this._descriptionLabel);

        this._highlightTerms();

        this.connect('destroy', () => {
            if (_toggleTimeout) {
                GLib.source_remove(_toggleTimeout);
                _toggleTimeout = 0;
            }
        });
    }

    _toggleExtension() {
        const state = this.extension.state;
        if (![1, 2, 6, 3].includes(state))
            return;

        if (_toggleTimeout)
            GLib.source_remove(_toggleTimeout);

        _toggleTimeout = GLib.timeout_add(GLib.PRIORITY_LOW, 200,
            () => {
                if ([7, 8].includes(this.extension.state))
                    return GLib.SOURCE_CONTINUE;

                this.icon?.destroy();
                this.icon = this.metaInfo['createIcon'](this.ICON_SIZE);
                this._iconBox.set_child(this.icon);
                this._highlightTerms();

                _toggleTimeout = 0;
                return GLib.SOURCE_REMOVE;
            }
        );

        if ([2, 6].includes(state))
            Main.extensionManager.enableExtension(this.extension.uuid);
        else if ([1, 3].includes(state))
            Main.extensionManager.disableExtension(this.extension.uuid);
    }

    get ICON_SIZE() {
        return 24;
    }

    _highlightTerms() {
        const extension = this.extension;
        const state = extension.state === 4 ? ExtensionState[this.extension.state] : '';
        const error = extension.state === 3 ? ` ERROR: ${this.extension.error}` : '';
        const update = extension.hasUpdate ? ' | UPDATE PENDING' : '';
        const text = `${this.metaInfo.version}    ${state}${error}${update}`;
        let markup = text;// this.metaInfo['description'].split('\n')[0];
        this._descriptionLabel.clutter_text.set_markup(markup);
    }

    vfunc_clicked() {
        this.activate();
    }

    activate() {
        this.provider.activateResult(this.metaInfo.id);

        if (this.metaInfo.clipboardText) {
            St.Clipboard.get_default().set_text(
                St.ClipboardType.CLIPBOARD, this.metaInfo.clipboardText);
        }
        Main.overview.toggle();
    }
});
