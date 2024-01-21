# ESP (Extensions Search Provider)
A GNOME Shell extension that gives you access to extensions settings through overview search.

This extensions has been originally crated as a module for V-Shell extension.

### Supported GNOME Shell versions
45, 46

![ESP (Extensions Search Provider)](screenshot.jpg)

## How to use ESP
1.  Open the overview (press and release the Super key or trigger the hot corner)
2.  a) Type the name of the extension you are looking for; results will be added to the global search<br>
    b) Type `eq//` to list all installed extensions. You can continue typing the name of an extension to filter the list
3.  Activate the search result to open extension's *Settings* window or click on the status icon to toggle the extension between enabled and disabled state

## Installation
### Installation from GitHub repository
You may need to install `git`, `make`, `gettext` and `glib2.0` for successful installation.
Navigate to the directory you want to download the source code and execute following commands in the terminal:

    git clone https://github.com/G-dH/extensions-search-provider.git
    cd extensions-search-provider
    make install

### Enabling the extension
After installation you need to enable the extension.

- First restart GNOME Shell (`ALt` + `F2`, `r`, `Enter`, or Log-Out/Log-In if you use Wayland)
- Now you should see the *ESP (Extensions Search Provider)* extension in the *Extensions* application (reopen the app if needed to load new data), where you can enable it.

## Buy me a coffee
If you like my extensions and want to keep me motivated give me some useful feedback, but you can also help me with my coffee expenses:
[buymeacoffee.com/georgdh](https://buymeacoffee.com/georgdh)
