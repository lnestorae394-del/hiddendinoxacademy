"use strict";
/* Роли самостоятельной Video Studio.
   user — зарегистрирован, ждёт подтверждения (доступа к студии нет); editor — монтажёр; admin — управляет проектами и пользователями; owner — владелец сайта.
   Старые названия принимаются как синонимы (super_admin → owner, student → user), остальные неизвестные роли считаются user — то есть без доступа. */
const ROLES = ["user", "editor", "admin", "owner"], RANK = { user: 0, editor: 1, admin: 2, owner: 3 };
const ALIAS = { owner: "owner", super_admin: "owner", admin: "admin", editor: "editor", montager: "editor", user: "user", student: "user" };
const normalize = r => ALIAS[String(r || "").toLowerCase()] || "user";
const roleOf = u => (u && u.blocked !== true ? normalize(u.role) : "user");
module.exports = { ROLES, RANK, roleOf, normalize, atLeast: (role, min) => RANK[normalize(role)] >= RANK[min] };
