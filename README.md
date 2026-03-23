# zabbixnophp

> *Слушайте. Все началось с простого вопроса: зачем нам PHP?*
> *Никто не смог ответить. Вот тогда и началась работа.*

---

## Идея

Zabbix — отличная система мониторинга. Демон на C, база на PostgreSQL, протокол JSON-RPC — всё сделано с умом. А потом смотришь на фронтенд и видишь пятьсот тысяч строк на PHP, Composer, jQuery и магию шаблонов.

Этот проект убирает PHP из уравнения. Полностью. Безвозвратно.

Демон Zabbix работает как раньше. База данных та же. JSON-RPC API тот же — только теперь его отвечает Python. А интерфейс — это один HTML-файл и несколько JS-модулей без единой зависимости.

---

## Стек

| Слой | Технология | Зачем |
|------|-----------|-------|
| Сервер | **aiohttp** | Async, без лишних слоёв |
| БД | **asyncpg** | Прямой PostgreSQL, никакого ORM |
| Auth | **bcrypt** | Хэши паролей как у Zabbix — совместимость |
| Frontend | **Vanilla JS ES modules** | Ноль зависимостей, ноль сборки |
| Стили | **CSS custom properties** | Одна тема, тёмная, по-взрослому |

Никакого webpack. Никакого npm. Никакого React. Файл открывается — страница работает.

---

## Запуск

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt

ZBX_DB_DSN=postgresql://zabbix:password@localhost/zabbix \
  .venv/bin/python -m api.main
```

Или через скрипт — он сам создаст venv если его нет:

```bash
ZBX_DB_DSN=postgresql://zabbix:password@localhost/zabbix ./run.sh
```

Порт `8090`. Zabbix-демон не трогаем. База данных та же самая.

---

## Структура

```
.
├── api/                        # Python backend
│   ├── main.py                 # aiohttp app, роуты, статика
│   ├── jsonrpc.py              # Диспетчер JSON-RPC 2.0
│   ├── db.py                   # Пул соединений asyncpg
│   ├── session.py              # Аутентификация через таблицу sessions
│   ├── rbac.py                 # Права доступа (ugset, hostgroup perms)
│   ├── tags.py                 # Фильтрация по тегам
│   ├── ids.py                  # Генератор ID через таблицу ids
│   └── methods/                # API методы — по одному файлу на объект
│       ├── user.py             # user.login / logout / get / create / update / delete
│       ├── usergroup.py        # usergroup.* + templategroup.get
│       ├── host.py             # host.get / create / update / delete
│       ├── hostgroup.py        # hostgroup.* + RBAC фильтр
│       ├── item.py             # item.* — все типы, HTTP agent, препроцессинг
│       ├── trigger.py          # trigger.* — выражения, зависимости
│       ├── discoveryrule.py    # LLD правила + условия фильтра
│       ├── itemprototype.py    # Прототипы элементов данных
│       ├── triggerprototype.py # Прототипы триггеров
│       ├── event.py            # event.get / acknowledge
│       ├── problem.py          # problem.get — активные и решённые
│       ├── history.py          # history.get / clear — все типы значений
│       ├── trend.py            # trend.get
│       ├── usermacro.py        # Макросы хостов и глобальные
│       ├── template.py         # template.* — шаблоны как хосты status=3
│       ├── maintenance.py      # Окна обслуживания
│       ├── action.py           # Действия (read-only)
│       ├── auditlog.py         # Журнал аудита
│       └── extra.py            # valuemap, proxy, role, application (stubs)
│
└── web/                        # Фронтенд — статика
    ├── index.html              # Единственный HTML-файл
    ├── css/main.css            # Все стили, тёмная тема
    └── js/
        ├── api.js              # JSON-RPC клиент, токен, ApiError
        ├── app.js              # Роутер, навигация, shell
        ├── pages/              # Страницы — по одному файлу
        │   ├── login.js
        │   ├── dashboard.js
        │   ├── problems.js
        │   ├── hosts.js
        │   ├── host-detail.js
        │   ├── host-items.js
        │   ├── discovery-rule.js
        │   ├── macros.js
        │   ├── latest.js
        │   ├── item.js
        │   ├── event-detail.js
        │   ├── hostgroups.js
        │   ├── templates.js
        │   ├── config-actions.js
        │   ├── config-maintenance.js
        │   ├── config-triggers.js
        │   ├── config-items.js
        │   ├── admin-users.js
        │   ├── admin-usergroups.js
        │   ├── admin-auditlog.js
        │   └── admin-proxies.js
        └── utils/
            ├── multiselect.js  # Chip-based выбор из списка
            ├── item-form.js    # Форма элемента данных (shared)
            ├── group-picker.js # Выбор группы
            ├── tag-filter.js   # Фильтр по тегам
            └── pagination.js   # Пагинация таблиц
```

---

## API — реализованные методы

70 методов. Совместимость с Zabbix 7.0 JSON-RPC.

```
apiinfo.version

user.login / logout / checkAuthentication / get / create / update / delete
usergroup.get / create / update / delete
templategroup.get

host.get / create / update / delete
hostgroup.get / create / update / delete

item.get / create / update / delete
itemprototype.get / create / update / delete

trigger.get / create / update / delete
triggerprototype.get / create / update / delete

discoveryrule.get / create / update / delete
graphprototype.get

event.get / acknowledge
problem.get
history.get / clear
trend.get

usermacro.get / create / update / delete
globalmacro.get / create / update / delete

template.get / create / update / delete
maintenance.get / create / update / delete
action.get
auditlog.get

valuemap.get / proxy.get / role.get / application.get
```

---

## Совместимость с базой

Никакой миграции. Проект работает с живой базой Zabbix 7.0 без единого изменения схемы.

- Пароли — `$2y$` bcrypt, тот же формат что у Zabbix
- Сессии — таблица `sessions`, sessionid как Bearer-токен
- ID — через таблицу `ids` с блокировкой `FOR UPDATE`, как оригинал
- Права — `rights` + `ugset` + RBAC для не-суперадминов
- Теги — 6 операторов фильтрации, evaltype 0/1/2

---

## Тесты

```bash
# Глубокое тестирование API — 800+ кейсов
.venv/bin/python3 test_api_deep.py

# Структурное сравнение с оригинальным Zabbix API
.venv/bin/python3 compare_api.py
```

---

## Зачем

Потому что хорошая система мониторинга заслуживает нормального сервера.
Потому что 500к строк PHP — это не архитектура, это осадок.
Потому что Python + PostgreSQL + нативный JS решают ту же задачу в десять раз меньшим количеством движущихся частей.

Всё остальное — детали.
