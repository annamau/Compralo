// Clicking the toolbar icon opens the side panel (a popup would close on the first click elsewhere).
const openOnClick = () => chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);
openOnClick();
chrome.runtime.onInstalled.addListener(openOnClick);
