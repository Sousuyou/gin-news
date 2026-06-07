/* アプリ化（ホーム画面に追加・オフライン対応）。CSP対応のため外部ファイル化。 */
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", function () {
      navigator.serviceWorker.register("service-worker.js");
    });
  }
