import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class WindowOnTopPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings('org.gnome.shell.extensions.window-on-top');

        const page = new Adw.PreferencesPage({ title: 'General', icon_name: 'preferences-system-symbolic' });
        window.add(page);

        const group = new Adw.PreferencesGroup({ title: 'Floating Icon' });
        page.add(group);

        // Position combo row
        const posRow = new Adw.ComboRow({
            title: 'Icon Position',
            subtitle: 'Which top corner of the window to place the floating icon',
        });

        const model = new Gtk.StringList();
        model.append('Left');
        model.append('Right');
        posRow.set_model(model);

        // Set initial value
        posRow.set_selected(settings.get_string('icon-position') === 'right' ? 1 : 0);

        posRow.connect('notify::selected', () => {
            settings.set_string('icon-position', posRow.get_selected() === 1 ? 'right' : 'left');
        });

        group.add(posRow);

        // Keep visible when pinned toggle
        const keepVisibleRow = new Adw.SwitchRow({
            title: 'Keep Visible When Pinned',
            subtitle: 'Keep the icon always visible while the window is pinned on top',
        });

        keepVisibleRow.set_active(settings.get_boolean('keep-visible-when-pinned'));

        keepVisibleRow.connect('notify::active', () => {
            settings.set_boolean('keep-visible-when-pinned', keepVisibleRow.get_active());
        });

        group.add(keepVisibleRow);

        // Persist without focus toggle
        const persistRow = new Adw.SwitchRow({
            title: 'Persist Without Focus',
            subtitle: 'Keep the icon attached to a pinned window even when another window gets focus',
        });

        persistRow.set_active(settings.get_boolean('persist-without-focus'));

        persistRow.connect('notify::active', () => {
            settings.set_boolean('persist-without-focus', persistRow.get_active());
        });

        group.add(persistRow);
    }
}
