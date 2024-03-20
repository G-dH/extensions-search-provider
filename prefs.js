/**
 * ESP (Extensions Search Provider)
 * prefs.js
 *
 * @author     GdH <G-dH@github.com>
 * @copyright  2024
 * @license    GPL-3.0
 */

'use strict';

import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import * as Settings from './settings.js';
import * as OptionsFactory from './optionsFactory.js';

// gettext
let _;

export default class ESP extends ExtensionPreferences {
    _getPageList() {
        const itemFactory = new OptionsFactory.ItemFactory();
        const pageList = [
            {
                name: 'general',
                title: _('Options'),
                iconName: 'open-menu-symbolic',
                optionList: this._getGeneralOptionList(itemFactory),
            },
            {
                name: 'about',
                title: _('About'),
                iconName: 'preferences-system-details-symbolic',
                optionList: this._getAboutOptionList(itemFactory),
            },
        ];

        return pageList;
    }

    fillPreferencesWindow(window) {
        this.Me = {};
        this.Me.Settings = Settings;

        this.Me.gSettings = this.getSettings();
        this.Me._ = this.gettext.bind(this);
        _ = this.Me._;
        this.Me.metadata = this.metadata;

        this.opt = new this.Me.Settings.Options(this.Me);
        this.Me.opt = this.opt;

        OptionsFactory.init(this.Me);

        window = new OptionsFactory.AdwPrefs(this.opt).getFilledWindow(window, this._getPageList());
        window.connect('close-request', () => {
            this.opt.destroy();
            this.opt = null;
            this.Me = null;
            _ = null;
        });

        window.set_default_size(840, 800);
    }


    // ////////////////////////////////////////////////////////////////////

    _getGeneralOptionList(itemFactory) {
        const optionList = [];

        optionList.push(
            itemFactory.getRowWidget(
                ''/* _('Options')*/
            )
        );

        optionList.push(
            itemFactory.getRowWidget(
                _('Custom Search Prefixes'),
                _('Strings separated by space. The search prefix is a character/string added in front of the searched pattern (optionally followed by a space), serving as both a blocker for other search providers and a command to ESP to list all results instead of the default, limited to 5 results. The default fixed search prefix is "eq//"'),
                itemFactory.newEditableEntry(),
                'customPrefixes'
            )
        );

        optionList.push(
            itemFactory.getRowWidget(
                _('Enable Fuzzy Match'),
                _('Enabling the fuzzy match allows you to skip letters in the pattern you are searching for and find "V-Shell" even if you enter "vll"'),
                itemFactory.newSwitch(),
                'fuzzyMatch'
            )
        );

        optionList.push(
            itemFactory.getRowWidget(
                _('Exclude Results From Global Search'),
                _('Show results only if a search prefix is used, so that ESP results do not clutter the global search'),
                itemFactory.newSwitch(),
                'excludeFromGlobalSearch'
            )
        );

        optionList.push(
            itemFactory.getRowWidget(
                _('Sorting'),
                _('Order of windows in the complete list when using a search prefix alone'),
                itemFactory.newDropDown(),
                'resultsOrder',
                [
                    [_('Alphabetical'), 0],
                    [_('Alphabetical, Incompatible last'), 1],
                    [_('Alphabetical, Enabled first, Incompatible last'), 2],
                    [_('Order of enabling, Incompatible last'), 3],
                ]
            )
        );

        optionList.push(
            itemFactory.getRowWidget(
                _('Show Incompatible Extensions'),
                _('Extensions that do not support the current Shell version can be excluded from search results. The complete list is the result you obtain when entering only a search prefix'),
                itemFactory.newDropDown(),
                'showIncompatible',
                [
                    [_('Hide'), 0],
                    [_('Show'), 1],
                    [_('Show in complete list'), 2],
                    [_('Show when prefix is used'), 3],
                ]
            )
        );

        optionList.push(
            itemFactory.getRowWidget(
                _('Highlighting'),
                _('The GNOME default highlighting style (bold) causes strings to be "randomly" ellipsized, often preventing you from seeing the whole string, even if there is space for it. The selected style will be applied to all search results globally. If you are using other extensions that offer this option, make sure you set the same setting in all of them.'),
                itemFactory.newDropDown(),
                'highlightingStyle',
                [
                    [_('Bold (GNOME Default)'), 0],
                    [_('Underline'), 1],
                    [_('None'), 2],
                ]
            )
        );

        optionList.push(
            itemFactory.getRowWidget(
                _('Fix Glitches When Disabling Extensions (Experimental)'),
                _('This option, upon ESP activation, changes the order in which extensions are enabled to minimize issues when using ESP for disabling other extensions.\n\nContext: When you disable an extension in the GNOME Shell, the extension system first disables all extensions that were enabled after the selected one in reverse order and then, after disabling the selected one, re-enables them. If you use ESP, which is also an extension, to disable an extension that was enabled before ESP, you will experience the search results view disappearing and reappearing again with updated results, instead of just changing the status icon. This feature also reorders V-Shell extension if enabled, as its rebasing causes the overview to close.'),
                itemFactory.newSwitch(),
                'reorderExtensions'
            )
        );

        /* optionList.push(
            itemFactory.getRowWidget(
                _('Extensions Icon Position'),
                _('Allows to add "Search Extensions" icon into Dash so you can directly toggle extensions search provider results'),
                itemFactory.newDropDown(),
                'dashIconPosition',
                [
                    [_('Hide'), 0],
                    [_('Start'), 1],
                    [_('End'), 2],
                ]
            )
        );*/

        return optionList;
    }

    _getAboutOptionList(itemFactory) {
        const optionList = [];

        optionList.push(itemFactory.getRowWidget(
            this.Me.metadata.name
        ));

        const versionName = this.Me.metadata['version-name'] ?? '';
        let version = this.Me.metadata['version'] ?? '';
        version = versionName && version ? `/${version}` : version;
        const versionStr = `${versionName}${version}`;
        optionList.push(itemFactory.getRowWidget(
            _('Version'),
            null,
            itemFactory.newLabel(versionStr)
        ));

        optionList.push(itemFactory.getRowWidget(
            _('Reset all options'),
            _('Reset all options to their default values'),
            itemFactory.newOptionsResetButton()
        ));


        optionList.push(itemFactory.getRowWidget(
            _('Links')
        ));

        optionList.push(itemFactory.getRowWidget(
            _('Homepage'),
            _('Source code and more info about this extension'),
            itemFactory.newLinkButton('https://github.com/G-dH/extensions-search-provider')
        ));

        /* optionList.push(itemFactory.getRowWidget(
            _('Changelog'),
            _("See what's changed."),
            itemFactory.newLinkButton('https://github.com/G-dH/extensions-search-provider/blob/main/CHANGELOG.md')
        ));*/

        optionList.push(itemFactory.getRowWidget(
            _('GNOME Extensions'),
            _('Rate and comment ESP on the GNOME Extensions site'),
            itemFactory.newLinkButton('https://extensions.gnome.org/extension/6721')
        ));

        optionList.push(itemFactory.getRowWidget(
            _('Report a bug or suggest new feature'),
            _('Help me to help you!'),
            itemFactory.newLinkButton('https://github.com/G-dH/extensions-search-provider/issues')
        ));

        optionList.push(itemFactory.getRowWidget(
            _('Buy Me a Coffee'),
            _('Enjoying ESP? Consider supporting it by buying me a coffee!'),
            itemFactory.newLinkButton('https://buymeacoffee.com/georgdh')
        ));

        return optionList;
    }
}
