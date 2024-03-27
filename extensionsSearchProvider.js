/**
 * ESP (Extensions Search Provider)
 * extensionsSearchProvider.js
 *
 * @author     GdH <G-dH@github.com>
 * @copyright  2024
 * @license    GPL-3.0
 */

'use strict';

import GLib from 'gi://GLib';
import St from 'gi://St';
import Gio from 'gi://Gio';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { Highlighter } from 'resource:///org/gnome/shell/misc/util.js';

import * as ListSearchResult from './listSearchResult.js';
import * as HighlighterOverride from './highlighter.js';

const Icon = {
    ENABLE: 'object-select-symbolic', // 'emblem-ok-symbolic'
    DISABLE: 'window-close-symbolic',
    ERROR: 'dialog-error',
    UNINSTALL: 'user-trash-symbolic',
    UPDATE: 'software-update-available', // 'software-update-available-symbolic'
    INCOMPATIBLE: 'software-update-urgent', // 'software-update-urgent-symbolic'
    HOMEPAGE: 'go-home-symbolic',
    SETTINGS: 'preferences-system-symbolic',
    INFO: 'dialog-information-symbolic',
};

let Me;
let opt;
// gettext
let _;
let _toggleTimeout;

// prefix helps to eliminate results from other search providers
// this prefix is also used by the V-Shell to activate this provider
const PREFIX = 'eq//';
const ID = 'extensions';

export class ExtensionsSearchProviderModule {
    constructor(me) {
        Me = me;
        opt = Me.opt;
        _  = Me._;
        Me.Icon = Icon;
        ListSearchResult.init(Me);

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
        Me._overrides = new Me.Util.Overrides();
        HighlighterOverride.enable(Me);

        // delay to ensure that all default providers are already registered
        let delay = 0;
        if (Main.layoutManager._startingUp)
            delay = 2000;
        this._enableTimeoutId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            delay,
            () => {
                if (!this._extensionsSearchProvider) {
                    this._extensionsSearchProvider = new ExtensionsSearchProvider();
                    this._registerProvider(this._extensionsSearchProvider);
                }
                this._enableTimeoutId = 0;
                return GLib.SOURCE_REMOVE;
            }
        );

        // In case the extension has been rebased after disabling another extension,
        // update the search results view so the user don't lose the context
        const searchEntry = Main.overview.searchEntry;
        if (Main.overview._shown && searchEntry.text) {
            const text = searchEntry.text;
            searchEntry.text = `${PREFIX}/`;
            GLib.idle_add(GLib.PRIORITY_LOW,
                () => {
                    searchEntry.text = text;
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
            this._unregisterProvider(this._extensionsSearchProvider);
            this._extensionsSearchProvider = null;
        }

        HighlighterOverride.disable();
        Me._overrides.removeAll();
        Me._overrides = null;

        console.debug('  ExtensionsSearchProviderModule - Disabled');
    }

    _registerProvider(provider) {
        const searchResults = Main.overview.searchController._searchResults;
        provider.searchInProgress = false;

        // _providers is the source for default result selection, so it has to match the order of displays
        // ESP should be below WSP, but above all other providers
        let position;
        if (searchResults._providers[1]?.id === 'open-windows')
            position = 2;
        else
            position = 1;

        searchResults._providers.splice(position, 0, provider);

        // create results display and add it to the _content
        searchResults._ensureProviderDisplay.bind(searchResults)(provider);

        // also move the display up in the search view
        // displays are at stable positions and show up when their providers have content to display
        searchResults._content.remove_child(provider.display);
        // put it on position 2 in case the WSP provider is also active - windows first
        searchResults._content.insert_child_at_index(provider.display, position);
        // if WSP is not enabled, ESP would be bellow another provider, so reload them to move them below
        // searchResults._reloadRemoteProviders();
    }

    _unregisterProvider(provider) {
        const searchResults = Main.overview.searchController._searchResults;
        searchResults._unregisterProvider(provider);
    }
}

class ExtensionsSearchProvider {
    constructor() {
        this.id = ID;
        const appSystem = Shell.AppSystem.get_default();

        let appInfo = appSystem.lookup_app('com.matjakeman.ExtensionManager.desktop')?.get_app_info();
        if (!appInfo)
            appInfo = appSystem.lookup_app('org.gnome.Extensions.desktop')?.get_app_info();
        // A real appInfo created from a commandline has often issues with overriding get_id() method, so we use dict instead
        if (!appInfo) {
            appInfo = {
                get_name: () => _('Extensions'),
                get_id: () => 'org.gnome.Nautilus.desktop', // id of an app that is usually installed to avoid error messages
                get_icon: () => Gio.icon_new_for_string('application-x-addon'),
                should_show: () => true,
                launch: () => {},
            };
        }

        this.appInfo = appInfo;
        this.canLaunchSearch = true;
        this.isRemoteProvider = false;
    }

    getInitialResultSet(terms/* , cancelable*/) {
        const extensions = {};
        Main.extensionManager._extensions.forEach(
            e => {
                extensions[e.uuid] = e;
            }
        );
        this.extensions = extensions;

        return new Promise(resolve => resolve(this._getResultSet(terms)));
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

        if (!prefix && opt.EXCLUDE_FROM_GLOBAL_SEARCH) {
            const results = [];
            this.resultIds = results.map(item => item.id);
            return this.resultIds;
        }

        this._listAllResults = !!prefix;

        // do not modify original terms
        let _terms = [...terms];
        // search for terms without prefix
        _terms[0] = _terms[0].replace(prefix, '');

        const candidates = this.extensions;

        this._terms = _terms;
        const term = _terms.join(' ').trim();

        let results = [];
        let m;
        for (let id in candidates) {
            const metadata = this.extensions[id].metadata;
            const text = `${metadata.name} ${metadata.description}`;
            if (opt.FUZZY)
                m = Me.Util.fuzzyMatch(term, text);
            else
                m = Me.Util.strictMatch(term, text);

            if (m !== -1)
                results.push({ weight: m, id });
        }

        // filter out incompatible if required
        const hideIncompatible = !opt.SHOW_INCOMPATIBLE || (!prefix && opt.INCOMPATIBLE_HIDE_GLOBAL) || (term && opt.INCOMPATIBLE_FULL_ONLY);
        if (hideIncompatible)
            results = results.filter(e => this.extensions[e.id].state !== 4);

        // regular search should be ordered by relevance
        if (!prefix || term) {
            // prefer enabled extensions when relevance is equal
            results.sort((a, b) => this.extensions[a.id].state !== 1 && [1, 3].includes(this.extensions[b.id].state));
            // prefer compatible extensions when relevance is equal
            results.sort((a, b) => this.extensions[a.id].state === 4 && this.extensions[b.id].state !== 4);
            results.sort((a, b) => Me.Util.isMoreRelevant(
                this.extensions[a.id].metadata.name,
                this.extensions[b.id].metadata.name,
                term)
            );
        } else {
            // sort alphabetically
            results.sort((a, b) => this.extensions[a.id].metadata.name.localeCompare(this.extensions[b.id].metadata.name));

            // enabled first
            if (opt.ENABLED_FIRST || opt.ORDER_OF_ENABLING) {
            // Move extensions with error behind enabled, they are also enabled by user until they disable it using ESP
                results.sort((a, b) => this.extensions[a.id].state !== 1 && [1, 3].includes(this.extensions[b.id].state));
            }

            // order in which extensions have been activated
            if (opt.ORDER_OF_ENABLING) {
                const order = Main.extensionManager._extensionOrder;
                results.sort((a, b) =>  {
                    const bIndex = order.indexOf(this.extensions[b.id].uuid);
                    return (bIndex > -1) && (order.indexOf(this.extensions[a.id].uuid) > bIndex);
                });
            }

            // incompatible last
            if (!hideIncompatible && opt.INCOMPATIBLE_LAST)
                results.sort((a, b) => this.extensions[a.id].state === 4 && this.extensions[b.id].state !== 4);
        }

        this.resultIds = results.map(item => item.id);

        this._updateHighlights();

        return this.resultIds;
    }

    getResultMetas(resultIds/* , callback = null*/) {
        const metas = resultIds.map(id => this.getResultMeta(id));
        return new Promise(resolve => resolve(metas));
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
            'description': `${result.metadata.description || ''}`,
            'url': result.metadata.url || '',
            'canUninstall': result.path.startsWith(GLib.get_user_data_dir()),
            'createIcon': size => {
                let icon = this.getIcon(result, size);
                return icon;
            },
        };
    }

    getIcon(extension, size) {
        let opacity = 0;
        let iconName = Icon.DISABLE;

        switch (extension.state) {
        case 1:
            if (extension.hasUpdate)
                iconName = Icon.UPDATE;
            else
                iconName = Icon.ENABLE;

            opacity = 255;
            break;
        case 3:
            if (Main.extensionManager._enabledExtensions.includes(extension.uuid)) {
                iconName = Icon.ENABLE;
                opacity = 100;
            } else {
                iconName = Icon.ERROR;
                opacity = 180;
            }
            break;
        case 4:
            iconName = Icon.INCOMPATIBLE;
            opacity = 180;
            break;
        }

        if (extension.hasUpdate) {
            iconName = Icon.UPDATE;
            opacity = 180;
        }

        const icon = new St.Icon({ icon_name: iconName, icon_size: size });
        icon.set({
            opacity,
        });

        return icon;
    }

    // The default highligting is done on terms change
    // but since we are modifying the terms, the highlighting needs to be done after that
    // On first run the result displays are not yet created,
    // so we also need this method to be called from each result display's constructor
    _updateHighlights() {
        const resultIds = this.resultIds;
        // make the highlighter global, so it can be used from the result display
        this._highlighter = new Highlighter(this._terms);
        resultIds.forEach(value => {
            this.display._resultDisplays[value]?._highlightTerms(this);
        });
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
        const row = extension._resultRow;
        if (Me.Util.isCtrlPressed() && Me.Util.isShiftPressed())
            row._openInstallDir.bind(row)();
        else if (Me.Util.isCtrlPressed())
            row._toggleExtension.bind(row)(extension);
        else if (Me.Util.isShiftPressed())
            row._toggleInfoBox.bind(row)();
        else if (extension.hasPrefs)
            Me.Util.openPreferences(extension.metadata);
        else
            Main.notify(extension.metadata.name, 'This extension has no Settings window');
    }

    filterResults(results, maxResults) {
        return this._listAllResults
            ? results
            : results.slice(0, maxResults);
    }

    getSubsearchResultSet(previousResults, terms/* , cancelable*/) {
        return this.getInitialResultSet(terms);
    }

    createResultObject(meta) {
        const lsr = new ListSearchResult.ListSearchResult(this, meta, this.extensions[meta.id]);
        this.extensions[meta.id]['_resultRow'] = lsr;
        return lsr;
    }
}
