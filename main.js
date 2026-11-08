// Sends keys, text and a click through `webContents.sendInputEvent()` to windows in different
// focus states, and reports what the page received
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');

const PAGE = `<!doctype html><input id="field"><button id="button" style="position:absolute; left:100px; top:100px; width:100px; height:50px">B</button>
<script>
	window.events = [];
	for(const type of ['keydown', 'keypress', 'input']) {
		field.addEventListener(type, e => events.push(type + (e.isTrusted ? '' : ' (untrusted)')));
	}
	button.addEventListener('click', e => events.push('click' + (e.isTrusted ? '' : ' (untrusted)')));
	document.addEventListener('mousemove', () => events.push('mousemove'), { once: true });
</script>`;

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const makeWindow = async (options = {}) => {
	const win = new BrowserWindow({ width: 400, height: 300, show: false, ...options });
	await win.loadURL('data:text/html,' + encodeURIComponent(PAGE));
	return win;
};
const whenEvent = (win, name) => new Promise(resolve => win.once(name, resolve));

const CASES = {
	'focused': async () => {
		const win = await makeWindow();
		win.show();
		app.focus({ steal: true });
		win.focus();
		return { win, others: [] };
	},
	'never-shown': async () => ({ win: await makeWindow(), others: [] }),
	'behind-focused': async () => {
		const win = await makeWindow();
		win.show();
		await wait(500);
		const other = await makeWindow({ x: 450, y: 50 });
		other.show();
		app.focus({ steal: true });
		other.focus();
		return { win, others: [other] };
	},
	'shown-inactive': async () => {
		const other = await makeWindow({ x: 450, y: 50 });
		other.show();
		app.focus({ steal: true });
		other.focus();
		const win = await makeWindow();
		win.showInactive();
		return { win, others: [other] };
	},
	'hidden-after-show': async () => {
		const win = await makeWindow();
		win.show();
		await wait(500);
		win.hide();
		return { win, others: [] };
	},
	'minimized': async () => {
		const win = await makeWindow();
		win.show();
		await wait(500);
		const minimized = whenEvent(win, 'minimize');
		win.minimize();
		await Promise.race([minimized, wait(3000)]);
		return { win, others: [] };
	},
};

async function probe(name, setup) {
	const { win, others } = await setup();
	await wait(1000);
	const wc = win.webContents;
	await wc.executeJavaScript('field.focus()');
	const state = { windowFocused: win.isFocused(), visible: win.isVisible(), minimized: win.isMinimized(), ...(await wc.executeJavaScript('({ pageFocused: document.hasFocus(), visibility: document.visibilityState })')) };
	for(const type of ['keyDown', 'char', 'keyUp']) {
		wc.sendInputEvent({ type, keyCode: 'a' });
	}
	wc.sendInputEvent({ type: 'mouseMove', x: 150, y: 125 });
	wc.sendInputEvent({ type: 'mouseDown', x: 150, y: 125, button: 'left', clickCount: 1 });
	wc.sendInputEvent({ type: 'mouseUp', x: 150, y: 125, button: 'left', clickCount: 1 });
	await wait(1000);
	const { value, events } = await wc.executeJavaScript('({ value: field.value, events })');
	for(const other of [win, ...others]) {
		other.destroy();
	}
	return { name, ...state, typed: value, events };
}

// Runs the case named last on the command line, in a process of its own
const LABELS = { 'focused': 'shown and focused (control)', 'never-shown': 'never shown', 'behind-focused': 'shown, another window focused', 'shown-inactive': 'shown inactive, never focused', 'hidden-after-show': 'hidden after shown', 'minimized': 'minimized' };

app.whenReady().then(async () => {
	// Ends a case that hangs, so the next still runs
	setTimeout(() => app.exit(3), 45_000).unref();
	const id = process.argv.at(-1);
	if(!CASES[id]) {
		console.error('unknown case "' + id + '" – one of ' + Object.keys(CASES).join(', '));
		app.exit(2);
		return;
	}
	const result = await probe(LABELS[id], CASES[id]).catch(e => ({ name: LABELS[id], error: e.message }));
	const platform = process.platform + ' ' + process.arch + ', Electron ' + process.versions.electron;
	console.log(JSON.stringify({ platform, result }));
	const row = result.error ? `| ${result.name} | – | – | – | – | error: ${result.error} |` : `| ${result.name} | ${result.windowFocused} | ${result.pageFocused} | ${result.visibility} | \`${result.typed}\` | ${result.events.join(', ') || 'none'} |`;
	if(process.env.GITHUB_STEP_SUMMARY) {
		fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, row + '\n');
	}
	app.exit(0);
});
