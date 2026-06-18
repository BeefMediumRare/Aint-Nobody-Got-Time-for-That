// background.js — owns the toolbar badge (the only place allowed to set it).
// Shows a red recording indicator + live marker count while authoring.

(function () {
  'use strict';

  var browserApi = (typeof browser !== 'undefined') ? browser : chrome;
  var action = browserApi.action || browserApi.browserAction;

  browserApi.runtime.onMessage.addListener(function (msg, sender) {
    if (!msg || msg.type !== 'badge') return;
    var tabId = sender.tab && sender.tab.id;
    if (msg.recording) {
      action.setBadgeBackgroundColor({ color: '#c0392b', tabId: tabId });
      action.setBadgeText({ text: msg.count ? String(msg.count) : '●', tabId: tabId });
    } else {
      action.setBadgeText({ text: '', tabId: tabId });
    }
  });
})();
