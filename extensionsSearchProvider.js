/**
 * ESP (Extensions Search Provider)
 * extensionsSearchProvider.js
 *
 * @author     GdH <G-dH@github.com>
 * @copyright  2024
 * @license    GPL-3.0
 */

'use strict';

const  { GLib, St, Gio, GObject, Clutter, Shell } = imports.gi;

const Main = imports.ui.main;
const Search = imports.ui.search;
const { Highlighter } = imports.misc.util;

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
// this prefix is also used by the V-Shell to activate this provider
const PREFIX = 'eq//';
const ID = 'extensions';

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
        this._overrides = new Me.Util.Overrides();
        this._overrides.addOverride('Highlighter', Highlighter.prototype, HighlighterOverride);
        this._overrides.addOverride('ListSearchResult', Search.ListSearchResult.prototype, ListSearchResultOverride);

        // GNOME 43/44 has a problem registering a new provider during Shell's startup
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
            Main.overview.searchEntry.text = `${PREFIX}/`;
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
            this._unregisterProvider(this._extensionsSearchProvider);
            this._extensionsSearchProvider = null;
        }

        this._overrides.removeAll();
        this._overrides = null;

        console.debug('  ExtensionsSearchProviderModule - Disabled');
    }

    _registerProvider(provider) {
        const searchResults = Main.overview._overview.controls._searchController._searchResults;
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
        const searchResults = Main.overview._overview.controls._searchController._searchResults;
        searchResults._unregisterProvider(provider);
    }
};

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

    getInitialResultSet(terms, callback, cancelable) {
        this.t = Date.now();
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
        else if (extension.hasPrefs)
            Me.Util.openPreferences(extension.metadata);
    }

    filterResults(results, maxResults) {
        return this._listAllResults
            ? results
            : results.slice(0, maxResults);
    }

    getSubsearchResultSet(previousResults, terms, callback, cancellable) {
        if (cancellable === undefined) {
            return this.getInitialResultSet(terms, cancellable);
        } else {
            this.getInitialResultSet(terms, callback, cancellable);
            return null;
        }
    }

    createResultObject(meta) {
        const lsr = new ListSearchResult(this, meta, this.extensions[meta.id]);
        this.extensions[meta.id]['toggleExtension'] = lsr._toggleExtension.bind(lsr);
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
        return 24;
    }

    _highlightTerms(provider) {
        let markup = provider._highlighter.highlight(this.metaInfo['name']);
        this.label_actor.clutter_text.set_markup(markup);
    }

    _updateState() {
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
