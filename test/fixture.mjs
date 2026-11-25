/**
 * A miniature desktop shell containing exactly the anchors the patcher knows.
 * Shared by the text-level and archive-level tests.
 */

/** Stock `main.js` text with region markers available as byte slack. */
export function shellFixture() {
  const regions = []
  for (let i = 0; i < 40; i += 1) {
    regions.push(`//#region fixture/part-${String(i)}`, `const filler${String(i)} = ${String(i)};`, `//#endregion`)
  }
  return `import { app, dialog, nativeImage } from "electron";
${regions.join('\n')}
async function main() {
	let quitting = false;
	const backend = {};
	const applicationIconPath = "icon.png";
	const hideCommands = [];
	const applicationItems = () => [
		{ type: "separator" },
		...hideCommands,
		{
			role: "quit",
			label: "Quit"
		}
	];
	const trayIconPath = "tray.ico";
	if (process.platform === "win32") try {
		tray = new DesktopTray({
			iconPath: trayIconPath,
			locale: () => {},
			open: () => {},
			quit: () => {}
		});
	} catch {}
}
var DesktopTray = class {
	relabel() {
		const { messages } = this.options.locale();
		tray.setContextMenu(Menu.buildFromTemplate([
			{
				label: messages.openApplication,
				click: () => {
					this.options.open();
				}
			},
			{ type: "separator" },
			{
				label: messages.quitApplication,
				click: () => {
					this.options.quit();
				}
			}
		]));
	}
};
export {};
`
}

/** A shell whose quit anchor was removed; the patcher must refuse it. */
export function unknownFixture() {
  return shellFixture().replace('...hideCommands,', '// anchor removed')
}
