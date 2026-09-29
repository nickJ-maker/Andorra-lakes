@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo ===  Публикация сайта «Озёра Андорры»  ===
echo.

rem Локальная проверка: разбор папок, координаты озёр (кэш data\geocache.json), предупреждения
where node >nul 2>nul
if %errorlevel%==0 (
  if not exist node_modules (
    echo Первый запуск: установка компонентов...
    call npm ci --omit=dev --no-fund --no-audit
  )
  echo Проверка озёр...
  call npm run build --silent
  if errorlevel 1 (
    echo.
    echo Сборка завершилась с ошибкой — см. сообщения выше. Публикация отменена.
    pause
    exit /b 1
  )
) else (
  echo Node.js не установлен — локальная проверка пропущена, сайт соберётся на GitHub.
)

echo.
git add lakes data
git diff --cached --quiet
if %errorlevel%==0 (
  echo Изменений в папке lakes нет — публиковать нечего.
  pause
  exit /b 0
)

git commit -m "Добавлены/обновлены озёра"
git push
if errorlevel 1 (
  echo.
  echo Не удалось отправить изменения на GitHub. Проверьте интернет и попробуйте ещё раз.
  pause
  exit /b 1
)

echo.
echo Готово! Сайт обновится через 2–5 минут.
echo Ход публикации: https://github.com/nickJ-maker/Andorra-lakes/actions
echo.
pause
