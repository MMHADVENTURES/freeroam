// FreeRoam — Background Service Worker
// Toolbar icon: focus an open Street View tab, or open Street View where you
// last were (Lower Broadway, Nashville on first run).

const DEFAULT_SV_URL = 'https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=36.16222,-86.77444&heading=270';
const MAPS_PREFIX = 'https://www.google.com/maps/';
// Street View URLs carry "@LAT,LNG,<n>a,<fov>y" (e.g. …,3a,75y… or …,24a,90y…)
const STREET_VIEW_RE = /@-?[\d.]+,-?[\d.]+,[\d.]+a,[\d.]+y/;

chrome.action.onClicked.addListener(async () => {
    const tabs = await chrome.tabs.query({ url: MAPS_PREFIX + '*' });
    const svTab = tabs.find((t) => t.url && STREET_VIEW_RE.test(t.url));

    if (svTab) {
        await chrome.tabs.update(svTab.id, { active: true });
        await chrome.windows.update(svTab.windowId, { focused: true });
        return;
    }
    const { lastSvUrl } = await chrome.storage.local.get(['lastSvUrl']);
    await chrome.tabs.create({ url: isStreetViewUrl(lastSvUrl) ? lastSvUrl : DEFAULT_SV_URL });
});

// content.js reports each new Street View URL so the icon can reopen it.
// Only Google Maps Street View URLs are ever stored or reopened.
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (sender.id === chrome.runtime.id && request.action === 'saveUrl' && isStreetViewUrl(request.url)) {
        chrome.storage.local.set({ lastSvUrl: request.url });
    }
    sendResponse({ ok: true });
    return false;
});

function isStreetViewUrl(url) {
    return typeof url === 'string' && url.startsWith(MAPS_PREFIX) && STREET_VIEW_RE.test(url);
}
