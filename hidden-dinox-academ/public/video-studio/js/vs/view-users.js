/* Раздел «Пользователи» (самостоятельный сайт): роли и блокировка. Права проверяет сервер; здесь только удобный интерфейс. */
(function () {
  "use strict";
  var VS = window.VS, $ = VS.$, esc = VS.esc, LABEL = { user: "Ожидает доступа", editor: "Монтажёр", admin: "Администратор", owner: "Владелец" };
  VS.views.users = {
    title: "Пользователи",
    mount: function (el) {
      el.innerHTML = '<div class="vs-ctop"><p class="vs-muted" style="margin:0">Новые пользователи регистрируются сами и получают роль «Ожидает доступа» — студия им не открыта. Назначьте роль, чтобы открыть доступ. Администратор назначает «Монтажёр» и «Ожидает доступа»; роль «Администратор» назначает только владелец.</p></div><div id="u-body"></div>';
      var sec = VS.section($("#u-body", el), { title: "Пользователи", load: function () { return VS.api("GET", "/users"); }, render: function (d, box) {
        var roles = d.can_grant_admin ? ["user", "editor", "admin", "owner"] : ["user", "editor"];
        box.innerHTML = d.users.length ? '<div class="vs-card"><div class="vs-tablewrap"><table class="vs-table"><thead><tr><th>Email</th><th>Роль</th><th>Последний вход</th><th>Доступ</th></tr></thead><tbody>' + d.users.map(function (u) {
          var locked = u.uid === d.me || (!d.can_grant_admin && (u.role === "admin" || u.role === "owner"));
          return "<tr><td><b>" + esc(u.email || u.uid) + "</b>" + (u.uid === d.me ? ' <span class="vs-badge">это вы</span>' : "") + '</td><td><select data-role="' + esc(u.uid) + '"' + (locked ? " disabled" : "") + ">" + (roles.indexOf(u.role) < 0 ? '<option selected>' + esc(LABEL[u.role] || u.role) + "</option>" : "") + roles.map(function (r) { return '<option value="' + r + '"' + (r === u.role ? " selected" : "") + ">" + LABEL[r] + "</option>"; }).join("") + "</select></td><td>" + (u.last_login_at ? VS.ago(u.last_login_at) : "—") + "</td><td>" + (u.blocked ? VS.badge("Заблокирован", "bad") : VS.badge("Активен", "ok")) + (locked ? "" : ' <button class="vs-btn sm ghost" data-block="' + esc(u.uid) + '" data-to="' + (u.blocked ? "0" : "1") + '">' + (u.blocked ? "Разблокировать" : "Заблокировать") + "</button>") + "</td></tr>";
        }).join("") + "</tbody></table></div></div>" : '<div class="vs-empty"><h3>Пользователей пока нет</h3></div>';
        box.onchange = function (e) { var s = e.target.closest("[data-role]"); if (!s) return; VS.api("PUT", "/users/" + encodeURIComponent(s.dataset.role) + "/role", { role: s.value }).then(function () { VS.toast("Роль изменена", "ok"); sec.reload(true); }).catch(function (x) { VS.toast(VS.errText(x), "bad"); sec.reload(true); }); };
        box.onclick = function (e) { var b = e.target.closest("[data-block]"); if (!b) return; VS.api("PUT", "/users/" + encodeURIComponent(b.dataset.block) + "/blocked", { blocked: b.dataset.to === "1" }).then(function () { VS.toast(b.dataset.to === "1" ? "Пользователь заблокирован" : "Пользователь разблокирован", "ok"); sec.reload(true); }).catch(function (x) { VS.toast(VS.errText(x), "bad"); }); };
      } });
    }
  };
})();
