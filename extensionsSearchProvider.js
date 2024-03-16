/**
 * ESP (Extensions Search Provider)
 * extensionsSearchProvider.js
 *
 * @author     GdH <G-dH@github.com>
 * @copyright  2024
 * @license    GPL-3.0
 */

'use strict';

import Atk from 'gi://Atk';
import GLib from 'gi://GLib';
import St from 'gi://St';
import Gio from 'gi://Gio';
import Shell from 'gi://Shell';
import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Search from 'resource:///org/gnome/shell/ui/search.js';
import * as ExtensionDownloader from 'resource:///org/gnome/shell/ui/extensionDownloader.js';
import { Highlighter } from 'resource:///org/gnome/shell/misc/util.js';

let ExtensionState;

const Icon = {
    ENABLE: 'object-select-symbolic', // 'emblem-ok-symbolic'
    DISABLE: 'window-close-symbolic',
    ERROR: 'dialog-error',
    UNINSTALL: 'user-trash-symbolic',
    UPDATE: 'software-update-available', // 'software-update-available-symbolic'
    INCOMPATIBLE: 'software-update-urgent', // 'software-update-urgent-symbolic'
    HOMEPAGE: 'go-home-symbolic',
    SETTINGS: 'preferences-system-symbolic',
};

const ICON_OPACITY = 150;

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

        this._firstActivation = true;
        this.moduleEnabled = false;
        this._extensionsSearchProvider = null;
        this._enableTimeoutId = 0;

        ExtensionState = {
            1: _('ENABLED'),
            2: _('DISABLED'),
            3: _('ERROR'),
            4: _('INCOMPATIBLE'),
            5: _('DOWNLOADING'),
            6: _('INITIALIZED'),
            7: _('DISABLING'),
            8: _('ENABLING'),
        };
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
        this._overrides = new Me.Util.Overrides();
        this._overrides.addOverride('Highlighter', Highlighter.prototype, HighlighterOverride);
        this._overrides.addOverride('ListSearchResult', Search.ListSearchResult.prototype, ListSearchResultOverride);

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
        if (Main.overview._shown && Main.overview.searchEntry.text) {
            const text = Main.overview.searchEntry.text;
            Main.overview.searchEntry.text = 'eq///';
            GLib.idle_add(GLib.PRIORITY_DEFAULT,
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
            this._unregisterProvider(this._extensionsSearchProvider);
            this._extensionsSearchProvider = null;
        }

        this._overrides.removeAll();
        this._overrides = null;

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
            const extension = this.extensions[id];
            const text = extension.metadata.name;
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
        if (opt.ENABLED_FIRST || opt.ORDER_OF_ENABLING)
            results.sort((a, b) => this.extensions[a.id].state !== 1 && this.extensions[b.id].state === 1);

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
            'description': versionStr, // description will be updated in result object
            'url': result.metadata.url || '',
            'canUninstall': !result.path.startsWith('/usr/'),
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
            if (Main.extensionManager._enabledExtensions.includes(extension.uuid))
                iconName = Icon.ENABLE;
            else
                iconName = Icon.ERROR;
            opacity = 180;
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
        if (Me.Util.isCtrlPressed())
            this.extensions[resultId].toggleExtension(extension);
        else if (Me.Util.isShiftPressed())
            this.extensions[resultId].openHomepage(extension);
        else if (extension.hasPrefs)
            Me.Util.openPreferences(extension.metadata);
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
        const lsr = new ListSearchResult(this, meta, this.extensions[meta.id]);
        this.extensions[meta.id]['toggleExtension'] = lsr._toggleExtension.bind(lsr);
        this.extensions[meta.id]['openHomepage'] = lsr._openHomepage.bind(lsr);
        return lsr;
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
        // reduce padding to compensate for button style
        this.set_style('padding-top: 3px; padding-bottom: 3px');

        let content = new St.BoxLayout({
            style_class: 'list-search-result-content',
            vertical: false,
            x_align: Clutter.ActorAlign.START,
            x_expand: true,
            y_expand: true,
        });
        this.set_child(content);

        // Uninstall button
        const uninstallIcon = new St.Icon({
            icon_name: Icon.UNINSTALL,
            icon_size: this.ICON_SIZE,
            opacity: ICON_OPACITY,
        });
        const uninstallBtn = new St.Button({
            toggle_mode: false,
            style_class: 'esp-button',
            x_align: Clutter.ActorAlign.END,
            // Homepage button should be visible and clickable only if url is available
            opacity: metaInfo.canUninstall ? 255 : 0,
            reactive: metaInfo.canUninstall,
            accessible_role: Atk.Role.PUSH_BUTTON,
        });
        uninstallBtn.connect('clicked', () => {
            if (!this._extensionUninstalled)
                this._uninstallExtension();
            return Clutter.EVENT_STOP;
        });
        uninstallBtn.set_child(uninstallIcon);
        content.add_child(uninstallBtn);

        // Homepage button
        const linkIcon = new St.Icon({
            icon_name: Icon.HOMEPAGE,
            icon_size: this.ICON_SIZE,
            opacity: ICON_OPACITY,
        });
        const linkBtn = new St.Button({
            toggle_mode: false,
            style_class: 'esp-button',
            x_align: Clutter.ActorAlign.END,
            // Homepage button should be visible and clickable only if url is available
            opacity: metaInfo.url ? 255 : 0,
            reactive: !!metaInfo.url,
            accessible_role: Atk.Role.LINK,
        });
        linkBtn.connect('clicked', () => {
            if (!this._extensionUninstalled)
                this._openHomepage();
            return Clutter.EVENT_STOP;
        });
        linkBtn.set_child(linkIcon);
        content.add_child(linkBtn);

        // Status button
        let icon = this.metaInfo['createIcon'](this.ICON_SIZE);
        let iconBox = new St.Button({
            style_class: 'esp-button',
            accessible_role: Atk.Role.CHECK_BOX,
        });
        iconBox.set_child(icon);
        iconBox.connect('enter-event', () => {
            if (this._extensionUninstalled || extension.state === 4)
                return;
            this._hoverIcon = new St.Icon({
                icon_name: [1, 3].includes(extension.state) ? Icon.DISABLE : Icon.ENABLE,
                icon_size: this.ICON_SIZE,
            });
            iconBox.set_child(this._hoverIcon);
        });
        iconBox.connect('leave-event', () => {
            if (this._extensionUninstalled || extension.state === 4)
                return;
            this.icon?.destroy();
            this.icon = this.metaInfo['createIcon'](this.ICON_SIZE);
            iconBox.set_child(this.icon);
        });
        content.add_child(iconBox);
        this._iconBox = iconBox;
        this.icon = icon;

        iconBox.connect('clicked', () => {
            if (!this._extensionUninstalled)
                this._toggleExtension();
            return Clutter.EVENT_STOP;
        });

        // Settings icon
        const prefsIcon = new St.Icon({
            icon_name: Icon.SETTINGS,
            icon_size: this.ICON_SIZE,
            style_class: 'esp-prefs',
            opacity: extension.hasPrefs ? ICON_OPACITY : 0,
        });
        content.add_child(prefsIcon);

        // Title label
        const titleBox = new St.BoxLayout({
            style_class: 'list-search-result-title',
            y_align: Clutter.ActorAlign.CENTER,
        });
        content.add_child(titleBox);

        const title = new St.Label({
            text: this.metaInfo['name'],
            y_align: Clutter.ActorAlign.CENTER,
        });
        titleBox.add_child(title);

        this.label_actor = title;

        this._descriptionLabel = new St.Label({
            style_class: 'list-search-result-description',
            y_align: Clutter.ActorAlign.CENTER,
        });
        content.add_child(this._descriptionLabel);

        this.connect('destroy', () => {
            if (_toggleTimeout) {
                GLib.source_remove(_toggleTimeout);
                _toggleTimeout = 0;
            }
        });

        this._updateState();

        // The first highlight
        this._highlightTerms(provider);
    }

    _openHomepage() {
        Main.overview.hide();
        Gio.AppInfo.launch_default_for_uri(this.metaInfo['url'], null);
        const appInfo = Gio.AppInfo.get_default_for_uri_scheme('http');
        if (appInfo) {
            const app = Shell.AppSystem.get_default().get_running().find(a => a.id === appInfo.get_id());
            app?.activate();
        }
    }

    _uninstallExtension() {
        this._lastTrashClick = this._lastTrashClick ?? 0;
        if (Date.now() - this._lastTrashClick > Clutter.Settings.get_default().double_click_time) {
            this._lastTrashClick = Date.now();
            return;
        } else {
            this._lastTrashClick = 0;
        }

        ExtensionDownloader.uninstallExtension(this.metaInfo.id);
        this._extensionUninstalled = true;
        this.ease({
            duration: 400,
            scale_x: 0,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    _toggleExtension() {
        const state = this.extension.state;
        if (![1, 2, 6, 3].includes(state))
            return;

        if (_toggleTimeout)
            GLib.source_remove(_toggleTimeout);

        // Hide the hover icon so the user gets some feedback that they clicked the toggle
        this._hoverIcon?.set_opacity(0);
        _toggleTimeout = GLib.timeout_add(GLib.PRIORITY_LOW, 200,
            () => {
                if ([7, 8].includes(this.extension.state))
                    return GLib.SOURCE_CONTINUE;

                this.icon?.destroy();
                this.icon = this.metaInfo['createIcon'](this.ICON_SIZE);
                this._iconBox.set_child(this.icon);
                this._updateState();

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
        return 20;
    }

    _highlightTerms(provider) {
        let markup = provider._highlighter.highlight(this.metaInfo['name']);
        this.label_actor.clutter_text.set_markup(markup);
    }

    _updateState() {
        const extension = this.extension;
        // const state = extension.state === 4 ? ExtensionState[this.extension.state] : '';
        const state = ExtensionState[this.extension.state];
        const error = extension.state === 3 ? `: ${this.extension.error}` : '';
        const update = extension.hasUpdate ? ` | ${_('UPDATE PENDING')}` : '';
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
        // Hold Ctrl to avoid leaving the overview
        // when enabling / disabling an extension using a keyboard
        if (!Me.Util.isCtrlPressed())
            Main.overview.toggle();
    }
});

// Add highlighting of the "name" part of the result for all providers
const ListSearchResultOverride = {
    _highlightTerms() {
        let markup = this._resultsView.highlightTerms(this.metaInfo['name']);
        this.label_actor.clutter_text.set_markup(markup);
        markup = this._resultsView.highlightTerms(this.metaInfo['description'].split('\n')[0]);
        this._descriptionLabel.clutter_text.set_markup(markup);
    },
};

const  HighlighterOverride = {
    /**
     * @param {?string[]} terms - list of terms to highlight
     */
    /* constructor(terms) {
        if (!terms)
            return;

        const escapedTerms = terms
            .map(term => Shell.util_regex_escape(term))
            .filter(term => term.length > 0);

        if (escapedTerms.length === 0)
            return;

        this._highlightRegex = new RegExp(
            `(${escapedTerms.join('|')})`, 'gi');
    },*/

    /**
     * Highlight all occurences of the terms defined for this
     * highlighter in the provided text using markup.
     *
     * @param {string} text - text to highlight the defined terms in
     * @returns {string}
     */
    highlight(text) {
        if (!this._highlightRegex)
            return GLib.markup_escape_text(text, -1);

        let escaped = [];
        let lastMatchEnd = 0;
        let match;
        let style = ['', ''];
        if (opt.HIGHLIGHT_DEFAULT)
            style = ['<b>', '</b>'];
        // The default highlighting by the bold style causes text to be "randomly" ellipsized in cases where it's not necessary
        // and also blurry
        // Underscore doesn't affect label size and all looks better
        else if (opt.HIGHLIGHT_UNDERLINE)
            style = ['<u>', '</u>'];

        while ((match = this._highlightRegex.exec(text))) {
            if (match.index > lastMatchEnd) {
                let unmatched = GLib.markup_escape_text(
                    text.slice(lastMatchEnd, match.index), -1);
                escaped.push(unmatched);
            }
            let matched = GLib.markup_escape_text(match[0], -1);
            escaped.push(`${style[0]}${matched}${style[1]}`);
            lastMatchEnd = match.index + match[0].length;
        }
        let unmatched = GLib.markup_escape_text(
            text.slice(lastMatchEnd), -1);
        escaped.push(unmatched);
        return escaped.join('');
    },
};
