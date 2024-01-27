#!/bin/bash
 
files='extension.js
extensionsSearchProvider.js
util.js
settings.js
prefs.js
optionsFactory.js
schemas/org.gnome.shell.extensions.extensions-search-provider.gschema.xml'

while read file; do
  cp -r ~/.local/share/gnome-shell/extensions/extensions-search-provider@G-dH.github.com-dev/$file ./$file
done <<< $files
find ./ -name '*.js' -exec sed -i '/print(\|print (\|LOG(\|LOG (\|LOG =/d' {} \;

