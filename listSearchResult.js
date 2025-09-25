/**
 * ESP (Extensions Search Provider)
 * listSearchResult.js
 *
 * @author     GdH <G-dH@github.com>
 * @copyright  2024 - 2025
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
import * as ExtensionDownloader from 'resource:///org/gnome/shell/ui/extensionDownloader.js';

const ICON_OPACITY = 255;

let ExtensionState;
let Icon;
let Me;
let opt;
let _;
let _toggleTimeout;

export function init(me) {
    Me = me;
    _ = Me._;
    Icon = Me.Icon;
    opt = Me.opt;

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

export function cleanGlobals() {
    Me = null;
    ExtensionState = null;
    _ = null;
    opt = null;
}

export const ListSearchResult = GObject.registerClass({
    GTypeName: `ListSearchResult${Math.floor(Math.random() * 1000)}`,
}, class ListSearchResult extends St.Button {
    _init(provider, metaInfo, extension) {
        this.provider = provider;
        this.metaInfo = metaInfo;
        this.extension = extension;

        super._init({
            reactive: true,
            can_focus: true,
            track_hover: true,
        });

        this.style_class = 'list-search-result esp-list-search-result';

        // masterBox is a container for content and infoBox
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
            // this.statusIcon?.destroy();
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
            style_class: metaInfo.version ? 'esp-extension-version' : '',
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

        // Settings icon
        const prefsIcon = new St.Icon({
            icon_name: Icon.SETTINGS,
            icon_size: this.ICON_SIZE,
            style_class: 'esp-icon',
            opacity: extension.hasPrefs ? 150 : 0,
        });

        // controlsBox holds infoBtn and uninstallBtn
        const controlsBox = new St.BoxLayout({
            style_class: 'list-search-result-content',
            vertical: false,
            x_align: Clutter.ActorAlign.END,
            x_expand: true,
            y_expand: true,
            reactive: true,
        });
        // Prevent activating the row if user accidentally clicks between button
        // Since GNOME 49 this connection blocks "clicked" signal of child buttons
        // might be related to the removed vfunc_button_press_event...
        // controlsBox.connect('button-press-event', () => Clutter.EVENT_STOP);

        // Info button
        const infoIcon = new St.Icon({
            icon_name: Icon.INFO,
            icon_size: this.ICON_SIZE,
            opacity: ICON_OPACITY,
        });
        const infoBtn = new St.Button({
            toggle_mode: false,
            // style_class is set in _updateState()
            reactive: true,
            accessible_role: Atk.Role.PUSH_BUTTON,
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
            accessible_role: Atk.Role.PUSH_BUTTON,
        });
        uninstallBtn.connect('clicked', () => {
            if (!this._extensionUninstalled)
                this._uninstallExtension();
            return Clutter.EVENT_STOP;
        });
        uninstallBtn.set_child(uninstallIcon);

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
                style_class: 'esp-info-box',
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
                text: `<b>${ExtensionState[3]/* ERROR*/}:</b>  ${this.extension.error.replace(/^Error: /, '')}`,
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
        let appInfo = Shell.AppSystem.get_default().lookup_app('ca.desrt.dconf-editor.desktop');
        if (appInfo) { // dconf-Editor installed
            const schemaPath = `/${this.extension.metadata['settings-schema'].replace(/\./g, '/')}`;
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
        if (!Me?.Util.isCtrlPressed() && !Me?.Util.isShiftPressed())
            Main.overview.hide();
    }
});
