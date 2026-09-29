@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo ===  Публикация сайта «Озёра Андорры»  ===
echo.

where node >nul 2>nul
if errorlevel 1 goto nonode

if not exist node_modules\piexifjs (
  echo Установка компонентов...
  call npm ci --omit=dev --no-fund --no-audit
)

rem 1. Удаление GPS-координат из оригиналов фото (без пересжатия)
echo Удаление GPS из фото...
call npm run strip-gps --silent
if errorlevel 1 (
  echo.
  echo Не у всех фото удалось удалить GPS — см. список выше. Публикация отменена.
  pause
  exit /b 1
)

rem 2. Проверка озёр: разбор папок, координаты (кэш data\geocache.json), предупреждения
echo.
echo Проверка озёр...
call npm run build --silent
if errorlevel 1 (
  echo.
  echo Сборка завершилась с ошибкой — см. сообщения выше. Публикация отменена.
  pause
  exit /b 1
)
goto publish

:nonode
echo ВНИМАНИЕ: Node.js не установлен — GPS-координаты из фото удалить не получится,
echo и фото попадут в публичный репозиторий вместе с местом съёмки.
echo Установить Node.js: https://nodejs.org (версия LTS).
echo.
choice /c YN /m "Всё равно опубликовать без очистки GPS"
if errorlevel 2 exit /b 1

:publish
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
