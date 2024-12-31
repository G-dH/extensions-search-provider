/**
 * ESP (Extensions Search Provider)
 * settings.js
 *
 * @author     GdH <G-dH@github.com>
 * @copyright  2024
 * @license    GPL-3.0
 */

'use strict';

import GLib from 'gi://GLib';

export const Options = class Options {
    constructor(me) {
        this.Me = me;

        this._gsettings = this.Me.gSettings;
        this._connectionIds = [];
        this._writeTimeoutId = 0;
        this._gsettings.delay();
        this.connect('changed', () => {
            if (this._writeTimeoutId)
                GLib.Source.remove(this._writeTimeoutId);

            this._writeTimeoutId = GLib.timeout_add(
                GLib.PRIORITY_DEFAULT,
                400,
                () => {
                    this._gsettings.apply();
                    this._updateCachedSettings();
                    this._writeTimeoutId = 0;
                    return GLib.SOURCE_REMOVE;
                }
            );
        });

        this.options = {
            customPrefixes:          ['string', 'custom-prefixes'],
            excludeFromGlobalSearch: ['boolean', 'exclude-from-global-search'],
            showIncompatible:        ['int', 'show-incompatible'],
            dashIconPosition:        ['int', 'dash-icon-position'],
            resultsOrder:            ['int', 'results-order'],
            fuzzyMatch:              ['boolean', 'fuzzy-match'],
            highlightingStyle:       ['int', 'highlighting-style'],
            reorderExtensions:       ['boolean', 'reorder-extensions'],
        };

        this.cachedOptions = {};

        this._updateCachedSettings();
    }

    _updateCachedSettings(/* settings, key */) {
        Object.keys(this.options).forEach(v => this.get(v, true));
        this._setOptionConstants();
        this._addPrefixesToPublicList();
    }

    get(option, updateCache = false) {
        if (updateCache || this.cachedOptions[option] === undefined) {
            const [, key, settings] = this.options[option];
            let gSettings;
            if (settings !== undefined)
                gSettings = settings();
            else
                gSettings = this._gsettings;


            this.cachedOptions[option] = gSettings.get_value(key).deep_unpack();
        }

        return this.cachedOptions[option];
    }

    set(option, value) {
        const [format, key] = this.options[option];
        switch (format) {
        case 'string':
            this._gsettings.set_string(key, value);
            break;
        case 'int':
            this._gsettings.set_int(key, value);
            break;
        case 'boolean':
            this._gsettings.set_boolean(key, value);
            break;
        }
    }

    getDefault(option) {
        const [, key] = this.options[option];
        return this._gsettings.get_default_value(key).deep_unpack();
    }

    connect(name, callback) {
        const id = this._gsettings.connect(name, callback);
        this._connectionIds.push(id);
        return id;
    }

    destroy() {
        this._connectionIds.forEach(id => this._gsettings.disconnect(id));
        if (this._writeTimeoutId)
            GLib.Source.remove(this._writeTimeoutId);
        this._writeTimeoutId = 0;
        this._gsettings = null;
        this._removePrefixesFromPublicList();
    }

    _setOptionConstants() {
        const REGEXP_SPECIAL_CHAR        = /[!#$%^&*)(+=.<>{}[\]:;'"|~`_-]/g;
        this.CUSTOM_PREFIXES             = this.get('customPrefixes').replace(REGEXP_SPECIAL_CHAR, '\\$&').split(' ');
        this.RESULTS_ORDER               = this.get('resultsOrder');
        this.ENABLED_FIRST               = this.RESULTS_ORDER === 2;
        this.ORDER_OF_ENABLING           = this.RESULTS_ORDER === 3;
        this.INCOMPATIBLE_LAST           = !!this.RESULTS_ORDER;
        this.EXCLUDE_FROM_GLOBAL_SEARCH  = this.get('excludeFromGlobalSearch');
        this.SHOW_INCOMPATIBLE           = this.get('showIncompatible');
        this.INCOMPATIBLE_FULL_ONLY      = this.SHOW_INCOMPATIBLE === 2;
        this.INCOMPATIBLE_HIDE_GLOBAL    = this.SHOW_INCOMPATIBLE === 3;
        this.FUZZY                       = this.get('fuzzyMatch');
        this.DASH_ICON_POSITION          = this.get('dashIconPosition');
        this.DASH_ICON_HIDEN             = !this.DASH_ICON_POSITION;
        this.HIGHLIGHTING_STYLE          = this.get('highlightingStyle');
        this.HIGHLIGHT_DEFAULT           = this.HIGHLIGHTING_STYLE === 0;
        this.HIGHLIGHT_UNDERLINE         = this.HIGHLIGHTING_STYLE === 1;
        this.HIGHLIGHT_NONE              = this.HIGHLIGHTING_STYLE === 2;
        this.REORDER_EXTENSIONS          = this.get('reorderExtensions');
    }

    _addPrefixesToPublicList() {
        // ignore if called from Settings window
        if (typeof global === 'undefined')
            return;

        if (!global.searchProvidersKeywords)
            global.searchProvidersKeywords = new Map();
        const prefixes = [this.Me.defaultPrefix];
        prefixes.push(...this.CUSTOM_PREFIXES);
        global.searchProvidersKeywords.set(this.Me.providerId, prefixes);
    }

    _removePrefixesFromPublicList() {
        // ignore if called from Settings window
        if (typeof global === 'undefined')
            return;

        global.searchProvidersKeywords?.delete(this.Me.providerId);
        if (global.searchProvidersKeywords?.size === 0)
            delete global.searchProvidersKeywords;
    }
};
