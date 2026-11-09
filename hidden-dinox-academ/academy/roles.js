"use strict";
/* Роли платформы. Права проверяются ТОЛЬКО на сервере. Роль хранится в users/{uid}.role
   и меняется только через админ-API (с проверкой прав) или скрипт scripts/set-role.js. */
const ROLES = ["student", "team_member", "streamer", "mentor", "moderator", "admin", "super_admin"];
const RANK = Object.fromEntries(ROLES.map((r, i) => [r, i]));
const LABELS = { student: "Student", team_member: "Team Member", streamer: "Streamer", mentor: "Mentor", moderator: "Moderator", admin: "Admin", super_admin: "Super Admin" };

// Минимальная роль для действия
const PERMISSIONS = {
  "admin.enter":        "mentor",       // вход в админ-панель
  "dashboard.view":     "mentor",
  "content.edit":       "mentor",       // черновики курсов, уроков, медиа
  "content.publish":    "admin",        // публикация / снятие с публикации
  "content.delete":     "admin",
  "announcements.edit": "moderator",
  "announcements.publish": "admin",
  "users.view":         "moderator",
  "users.block":        "admin",
  "users.role":         "admin",        // назначать можно только роли НИЖЕ своей
  "audit.view":         "admin",
  "diagnostics.view":   "super_admin",
  "partners.view":      "admin",        // кабинеты партнёров, приглашения, заявки
  "finance.payouts":    "admin",        // смена статусов заявок на вывод (выплата — только с подтверждением)
  "finance.adjust":     "super_admin",  // ручные корректировки баланса
  "links.manage":       "admin",        // партнёрские ссылки Pocket Partners
  "import.course":      "admin",
  "features.manage":    "admin",        // карточки функций Academy (AI Mentor, Daily Tests, Chart Training)
  "daily.manage":       "admin",        // Daily Tests: банк вопросов, пропорции, наборы
  "chart.manage":       "admin",        // Chart Training: сценарии, импорт CSV
  "mentor.manage":      "admin"         // ИИ-помощник: лимиты, бюджет, расход
};

const roleOf = user => (user && ROLES.includes(user.role) ? user.role : "student");
const can = (role, perm) => PERMISSIONS[perm] !== undefined && RANK[role] >= RANK[PERMISSIONS[perm]];
// Назначить роль target пользователю с ролью current может только тот, чья роль строго выше обеих
const canAssign = (actorRole, currentRole, targetRole) =>
  ROLES.includes(targetRole) && RANK[actorRole] > RANK[targetRole] && RANK[actorRole] > RANK[currentRole] && can(actorRole, "users.role");

module.exports = { ROLES, RANK, LABELS, PERMISSIONS, roleOf, can, canAssign };
