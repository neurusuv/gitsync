@echo off
cd C:\gitsync




:: 添加所有更改
git add .

:: 提交更改
git commit -m "Auto commit."



:: 获取当前时间并格式化为分支名称（如：backup_YYYYMMDD_HHMMSS）
for /f "tokens=1-4 delims=:. " %%i in ("%date% %time%") do (
    set datetime=%%i%%j%%k_%%l
)
set branchname=backup_%datetime%

:: 拉取最新的更改
git pull origin master

:: 检查是否有合并冲突并使用 'ours' 策略无条件合并
if %errorlevel% neq 0 (
    echo Pull failed due to conflicts. Creating backup branch and attempting to merge using 'ours' strategy.

    :: 从远程创建新的备份分支
    git fetch origin
    git branch %branchname% origin/master
    git push origin %branchname%
    
    :: 进行合并，选择本地分支的更改
    git merge -X ours origin/master

    if %errorlevel% neq 0 (
        echo Merge using 'ours' strategy failed. Please check manually.
 
        exit /b %errorlevel%
    )
)


:: 推送到 origin 仓库的 master 分支
git push origin master

:: 合并 origin/master 到本地 master 使用 'ours' 策略
git fetch origin
git merge -X ours origin/master

:: 检查合并结果
if %errorlevel% neq 0 (
    echo Merge using 'ours' strategy failed. Please check manually.
   
    exit /b %errorlevel%
)

echo All operations completed successfully.
 
 
    exit /b  
 