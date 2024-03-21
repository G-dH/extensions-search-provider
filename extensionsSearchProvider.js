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
    INFO: 'dialog-information-symbolic',
};

const ICON_OPACITY = 255;

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
        const lsr = new ListSearchResult(this, meta, this.extensions[meta.id]);
        this.extensions[meta.id]['_resultRow'] = lsr;
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

        const masterBox = new St.BoxLayout({
            style_class: 'list-search-result-content',
            vertical: true,
            // x_align: Clutter.ActorAlign.START, // aligning cancels expand properties
            x_expand: true,
            y_expand: true,
        });
        this.set_child(masterBox);

        const content = new St.BoxLayout({
            style_class: 'list-search-result-content',
            vertical: false,
            // x_align: Clutter.ActorAlign.START, // aligning cancels expand properties
            x_expand: true,
            y_expand: true,
        });
        masterBox.add_child(content);
        this._masterBox = masterBox;
        this.set_child(masterBox);

        // Status button
        const statusIcon = this.metaInfo['createIcon'](this.ICON_SIZE);
        const statusBtn = new St.Button({
            style_class: 'esp-button',
            accessible_role: Atk.Role.CHECK_BOX,
        });
        statusBtn.set_child(statusIcon);
        statusBtn.connect('enter-event', () => {
            if (this._extensionUninstalled || extension.state === 4)
                return;
            this._hoverIcon = new St.Icon({
                icon_name: [1, 3].includes(extension.state) ? Icon.DISABLE : Icon.ENABLE,
                icon_size: this.ICON_SIZE,
            });
            statusBtn.set_child(this._hoverIcon);
        });
        statusBtn.connect('leave-event', () => {
            if (this._extensionUninstalled || extension.state === 4)
                return;
            this.statusIcon?.destroy();
            this.statusIcon = this.metaInfo['createIcon'](this.ICON_SIZE);
            statusBtn.set_child(this.statusIcon);
        });
        this._statusBtn = statusBtn;
        this.statusIcon = statusIcon;

        statusBtn.connect('clicked', () => {
            this.grab_key_focus();
            if (!this._extensionUninstalled)
                this._toggleExtension();
            return Clutter.EVENT_STOP;
        });

        // Settings icon
        const prefsIcon = new St.Icon({
            icon_name: Icon.SETTINGS,
            icon_size: this.ICON_SIZE,
            style_class: 'esp-icon',
            opacity: extension.hasPrefs ? 150 : 0,
        });

        const infoBtn = new St.Button({
            toggle_mode: false,
            // style_class is set in the _updateState()
            reactive: true,
            accessible_role: Atk.Role.PUSH_BUTTON,
        });

        // Title label
        const titleBox = new St.BoxLayout({
            style_class: 'list-search-result-title',
            y_align: Clutter.ActorAlign.CENTER,
            reactive: true,
            x_expand: true,
        });

        const title = new St.Label({
            text: this.metaInfo['name'],
            y_align: Clutter.ActorAlign.CENTER,
        });
        // Disable ellipsize for the title so it can't be ellispized
        // because of use of filling widget which forces
        // the search results to set to their maximum size when created
        title.clutter_text.set({
            ellipsize: 0,
        });
        titleBox.add_child(title);
        this._titleLabel = title;

        // Version label
        const versionLabel = new St.Label({
            text: metaInfo.version,
            style_class: metaInfo.version ? 'esp-button' : '',
            y_align: Clutter.ActorAlign.CENTER,
            // visible: false,
            opacity: 180,
        });
        this._versionLabel = versionLabel;
        titleBox.add_child(versionLabel);

        // Force full width on first allocation
        const fillingWidget = new St.Label({
            text: '                                                                                                                                                                                                                                                        ',
            opacity: 0,
            x_expand: true,
        });

        // Info icon
        const infoIcon = new St.Icon({
            icon_name: Icon.INFO,
            icon_size: this.ICON_SIZE,
            opacity: ICON_OPACITY,
        });

        infoBtn.set_child(infoIcon);

        infoBtn.connect('clicked', () => {
            this.grab_key_focus();
            this._toggleInfoBox();
        });

        this._infoBtn = infoBtn;

        // Status label
        this._statusLabel = new St.Label({
            style_class: 'list-search-result-description',
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });

        const controlsBox = new St.BoxLayout({
            style_class: 'list-search-result-content',
            vertical: false,
            x_align: Clutter.ActorAlign.END,
            x_expand: true,
            y_expand: true,
            reactive: true,
        });
        controlsBox.connect('button-press-event', () => true);


        // Uninstall button
        const uninstallIcon = new St.Icon({
            icon_name: Icon.UNINSTALL,
            icon_size: this.ICON_SIZE,
            opacity: ICON_OPACITY,
        });
        const uninstallBtn = new St.Button({
            toggle_mode: false,
            style_class: 'esp-button-trash',
            // Uninstall button should be visible and clickable only if installed in userspace
            opacity: metaInfo.canUninstall ? 255 : 0,
            reactive: metaInfo.canUninstall,
        });
        uninstallBtn.connect('clicked', () => {
            if (!this._extensionUninstalled)
                this._uninstallExtension();
            return Clutter.EVENT_STOP;
        });
        uninstallBtn.set_child(uninstallIcon);
        uninstallBtn.get_accessible().accessible_role = Atk.Role.PUSH_BUTTON;

        content.add_child(statusBtn);
        content.add_child(titleBox);
        content.add_child(fillingWidget);
        content.add_child(this._statusLabel);
        content.add_child(prefsIcon);
        controlsBox.add_child(infoBtn);
        controlsBox.add_child(uninstallBtn);
        content.add_child(controlsBox);

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

    _toggleInfoBox() {
        // Create on demand
        if (!this._infoBox) {
            this._infoBox = new St.BoxLayout({
                vertical: true,
                x_expand: true,
                visible: false,
                opacity: 220,
            });
            this._masterBox.add_child(this._infoBox);
        }

        // Error label
        if (this.extension.error && !this._errorLabel) {
            this._errorLabel = new St.Label({
                style_class: 'esp-error',
                y_align: Clutter.ActorAlign.CENTER,
                x_expand: true,
                can_focus: true,
                reactive: true,
            });
            this._errorLabel.clutter_text.set({
                ellipsize: 0,
                line_wrap: true,
                text: `<b>${ExtensionState[3]/* ERROR*/}:</b>  ${this.extension.error}`,
                use_markup: true,
            });
            this._errorLabel.connect('button-press-event', () => true);

            this._infoBox.insert_child_at_index(this._errorLabel, 0);
        }

        // Description label
        if (!this._descriptionLabel) {
            const descriptionBtn = new St.Button({
                style_class: 'esp-info-box-button',
                y_align: Clutter.ActorAlign.CENTER,
                x_expand: true,
            });
            descriptionBtn.connect('button-press-event', () => true);

            this._descriptionLabel = new St.Label({
                y_align: Clutter.ActorAlign.CENTER,
                x_expand: true,
            });
            this._descriptionLabel.clutter_text.set({
                ellipsize: 0,
                line_wrap: true,
            });
            this._highlightTerms(this.provider);
            descriptionBtn.set_child(this._descriptionLabel);
            this._infoBox.add_child(descriptionBtn);

            // Homepage button
            const linkLabel = new St.Label({
                y_align: Clutter.ActorAlign.CENTER,
                x_expand: true,
                visible: !!this.metaInfo.url,
            });
            linkLabel.clutter_text.set_markup(`<b>Homepage:</b>  ${this.metaInfo.url}`);

            const linkBtn = new St.Button({
                style_class: 'esp-info-box-button',
                y_align: Clutter.ActorAlign.CENTER,
                x_expand: true,
                can_focus: true,
            });

            linkBtn.connect('clicked', () => this._openHomepage());

            linkBtn.set_child(linkLabel);
            this._infoBox.add_child(linkBtn);

            // UUID label
            const uuidBtn = new St.Button({
                style_class: 'esp-info-box-button',
                y_align: Clutter.ActorAlign.CENTER,
                x_expand: true,
            });
            const uuidLabel = new St.Label({
                y_align: Clutter.ActorAlign.CENTER,
                x_expand: true,
            });
            uuidLabel.clutter_text.set_markup(`<b>${_('UUID')}:</b>  ${this.metaInfo.id}`);

            uuidBtn.connect('clicked', () => this._openMetadata());

            uuidBtn.set_child(uuidLabel);
            this._infoBox.add_child(uuidBtn);

            // Path label
            const pathBtn = new St.Button({
                style_class: 'esp-info-box-button',
                y_align: Clutter.ActorAlign.CENTER,
                x_expand: true,
                can_focus: true,
            });
            const pathLabel = new St.Label({
                y_align: Clutter.ActorAlign.CENTER,
                x_expand: true,
            });
            pathLabel.clutter_text.set_markup(`<b>${_('Path')}:</b>  ${this.extension.path}`);

            pathBtn.connect('clicked', () => this._openInstallDir());

            pathBtn.set_child(pathLabel);
            this._infoBox.add_child(pathBtn);

            // Schema label
            const schema = this.extension.metadata['settings-schema'];
            const schemaBtn = new St.Button({
                style_class: 'esp-info-box-button',
                y_align: Clutter.ActorAlign.CENTER,
                x_expand: true,
                can_focus: true,
                visible: !!schema,
            });
            const schemaLabel = new St.Label({
                y_align: Clutter.ActorAlign.CENTER,
                x_expand: true,
            });
            schemaLabel.clutter_text.set_markup(`<b>${_('Schema')}:</b>  ${schema}`);

            schemaBtn.connect('clicked', () => this._openSchema());

            schemaBtn.set_child(schemaLabel);
            this._infoBox.add_child(schemaBtn);

            // Readme button
            const readmePath = this._findREADME()[0] || '';
            const readmeBtn = new St.Button({
                style_class: 'esp-info-box-button',
                y_align: Clutter.ActorAlign.CENTER,
                x_expand: true,
                can_focus: true,
                visible: !!readmePath,
            });
            const readmeLabel = new St.Label({
                y_align: Clutter.ActorAlign.CENTER,
                x_expand: true,
            });
            readmeLabel.clutter_text.set_markup(`<b>${_('README')}:</b>  ./${readmePath.replace(/\/.*\//, '')}`);

            readmeBtn.connect('clicked', () => this._openREADME(readmePath));

            readmeBtn.set_child(readmeLabel);
            this._infoBox.add_child(readmeBtn);
        }

        const visible = this._infoBox.visible;
        this._infoBox.visible = true;
        this._infoBox.scale_y = visible ? 1 : 0;
        this._infoBox.ease({
            scale_y: visible ? 0 : 1,
            duration: 100,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                this._infoBox.visible = !visible;
            },
        });

        this._statusLabel.scale_y = visible ? 1 : 0;
        this._statusLabel.visible = true;
        this._statusLabel.ease({
            scale_y: visible ? 0 : 1,
            duration: 100,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                this._statusLabel.visible = !visible;
            },
        });
    }

    _openMetadata() {
        Main.overview.hide();
        Gio.AppInfo.launch_default_for_uri(`file://${this.extension.path}/metadata.json`, null);
        let appInfo = Gio.AppInfo.get_default_for_type('application/json', false);
        if (appInfo) {
            const app = Shell.AppSystem.get_default().get_running().find(a => a.id === appInfo.get_id());
            app?.activate();
        } else {
            St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, this.metaInfo.id);
            St.Clipboard.get_default().set_text(St.ClipboardType.PRIMARY, this.metaInfo.id);
            Main.notify('UUID has been copied to the clipboard', this.metaInfo.id);
        }
    }

    _openInstallDir() {
        Main.overview.hide();
        Gio.AppInfo.launch_default_for_uri(`file://${this.extension.path}`, null);
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

    _openSchema() {
        // Open schema in dconf-Editor if available
        const schemaPath = `/${this.extension.metadata['settings-schema'].replace(/\./g, '/')}`;
        let appInfo = Shell.AppSystem.get_default().lookup_app('ca.desrt.dconf-editor.desktop');
        const app = Shell.AppSystem.get_default().get_running().find(a => a.id === appInfo.get_id());
        Main.overview.hide();
        if (app) {
            // If dconf-Editor is already open, we cannot change the schema it is displaying,
            // so copy the path to the clipboard so the user can paste it to the path field manually
            St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, schemaPath);
            St.Clipboard.get_default().set_text(St.ClipboardType.PRIMARY, schemaPath);
            Main.notify('Schema has been copied to the clipboard', schemaPath);
        } else {
            appInfo = Gio.AppInfo.create_from_commandline(`/usr/bin/dconf-editor ${schemaPath}`, 'dconf-Editor', null);
            appInfo?.launch([], global.create_app_launch_context(global.get_current_time(), -1));
        }
        app?.activate();
    }

    _openREADME(path) {
        Main.overview.hide();
        Gio.AppInfo.launch_default_for_uri(`file://${path}`, null);
    }

    _findREADME() {
        const extDir = this.extension.path;
        const dir = Gio.file_new_for_path(extDir);
        const enumerator = dir.enumerate_children('', 0, null);

        const files = [];
        let fileInfo;
        while ((fileInfo = enumerator.next_file(null)) !== null) {
            const fileName = fileInfo.get_name();
            if (fileName.toLowerCase().includes('readme')) {
                const filePath = GLib.build_filenamev([extDir, fileName]);
                files.push(filePath);
            }
        }

        return files;
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
            duration: 250,
            scale_x: 0,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                this.scale_y = 0;
            },
        });
    }

    _toggleExtension() {
        if (this.metaInfo.id === Me.metadata.uuid) {
            Main.notify(Me.metadata.name, _('Suicide is not allowed, please use another way to disable ESP'));
            return;
        }

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

                this.statusIcon?.destroy();
                this.statusIcon = this.metaInfo['createIcon'](this.ICON_SIZE);
                this._statusBtn.set_child(this.statusIcon);
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
        let markup = provider._highlighter.highlight(this.metaInfo['name'], opt);

        // clutter_text.set_markup(markup)
        // should essentially do this two steps:
        // clutter_text.set_text(markup)
        // clutter_text.set_use_markup(true)
        // In practice, the first (convenience) function, when used repeatedly on the same St.Label,
        // acts as if it is one step behind. Each update of the same string with a different markup
        // shows the previous markup in the label. We can simply call the function twice,
        // or we can use the two separate functions to fix it.
        // Seems like this issue is related to disabled ellipsization
        this._titleLabel.clutter_text.set_text(markup);
        this._titleLabel.clutter_text.set_use_markup(true);
        if (this._descriptionLabel) {
            markup = provider._highlighter.highlight(this.metaInfo['description'], opt);
            // markup = `<b>${_('Description')}:</b> ${markup}`;
            this._descriptionLabel.clutter_text.set_text(markup);
            this._descriptionLabel.clutter_text.set_use_markup(true);
        }
    }

    _updateState() {
        const extension = this.extension;
        // const state = extension.state === 4 ? ExtensionState[this.extension.state] : '';
        const state = ExtensionState[this.extension.state];
        const update = extension.hasUpdate ? `${_('UPDATE PENDING')} | ` : '';
        const text = `${update}${state}`;
        this._statusLabel.text = text;// this.metaInfo['description'].split('\n')[0];
        this._infoBtn.set_style_class_name(extension.state === 3 ? 'esp-info-button-alert' : 'esp-info-button');
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
        // Prevent closing overview here if user activated special action
        if (!Me.Util.isCtrlPressed() && !Me.Util.isShiftPressed())
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
    highlight(text, options) {
        if (!this._highlightRegex)
            return GLib.markup_escape_text(text, -1);

        // force use local settings if the class is overridden by another extension (V-Shell, WSP)
        const o = options || opt;
        let escaped = [];
        let lastMatchEnd = 0;
        let match;
        let style = ['', ''];
        if (o.HIGHLIGHT_DEFAULT)
            style = ['<b>', '</b>'];
        // The default highlighting by the bold style causes text to be "randomly" ellipsized in cases where it's not necessary
        // and also blurry
        // Underscore doesn't affect label size and all looks better
        else if (o.HIGHLIGHT_UNDERLINE)
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
