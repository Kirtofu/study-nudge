#Requires -Version 5.1
<#
  study-nudge — 给自己用的每日学习督促小工具（零依赖，纯 PowerShell）

  用法:
    .\study-nudge.ps1 status              查看今天/连续天数/总进度
    .\study-nudge.ps1 log 1.5 "写了 rmsnorm kernel"   记一次学习（小时数 + 备注）
    .\study-nudge.ps1 remind              手动弹一次督促通知
    .\study-nudge.ps1 install [20:00]     注册每天定时提醒（默认 20:00）
    .\study-nudge.ps1 uninstall           取消定时提醒

  数据存在脚本同目录的 data.json，随时可以手改/删。
#>

[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string]$Command = 'status',

    [Parameter(Position = 1)]
    [string]$Arg1,

    [Parameter(Position = 2)]
    [string]$Arg2
)

$ErrorActionPreference = 'Stop'

# ---- 配置 ----
$ScriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$DataFile   = Join-Path $ScriptDir 'data.json'
$GoalHours  = 350          # ada-serve 的 mustHave 预算，作为总目标
$DailyGoal  = 2.0          # 每天目标小时数（15-20h/周 ≈ 每天 2-3h）
$TaskName   = 'StudyNudge-DailyReminder'

# ---- 数据读写 ----
function Get-Data {
    if (Test-Path $DataFile) {
        try {
            $raw = Get-Content $DataFile -Raw -Encoding UTF8
            if ([string]::IsNullOrWhiteSpace($raw)) { return @() }
            $obj = $raw | ConvertFrom-Json
            # 保证返回数组
            return @($obj)
        } catch {
            Write-Warning "data.json 读取失败，当作空数据处理：$($_.Exception.Message)"
            return @()
        }
    }
    return @()
}

function Save-Data($sessions) {
    # ConvertTo-Json 对单元素数组会退化成对象，强制包一层
    $json = @($sessions) | ConvertTo-Json -Depth 5
    # 单元素时 ConvertTo-Json 不会加 []，手动纠正
    if (@($sessions).Count -eq 1) { $json = "[$json]" }
    Set-Content -Path $DataFile -Value $json -Encoding UTF8
}

# ---- 通知（原生 toast 优先，失败退化成消息框）----
function Show-Notification {
    param([string]$Title, [string]$Message)

    $shown = $false
    try {
        [void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
        [void][Windows.UI.Notifications.ToastNotification, Windows.UI.Notifications, ContentType = WindowsRuntime]
        [void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]

        $template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent(
            [Windows.UI.Notifications.ToastTemplateType]::ToastText02)
        $texts = $template.GetElementsByTagName('text')
        $texts.Item(0).AppendChild($template.CreateTextNode($Title))  | Out-Null
        $texts.Item(1).AppendChild($template.CreateTextNode($Message)) | Out-Null

        $appId  = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
        $toast  = [Windows.UI.Notifications.ToastNotification]::new($template)
        [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)
        $shown = $true
    } catch {
        $shown = $false
    }

    if (-not $shown) {
        try {
            Add-Type -AssemblyName System.Windows.Forms
            [System.Windows.Forms.MessageBox]::Show($Message, $Title) | Out-Null
        } catch {
            # 最后兜底：直接打印
            Write-Host "[$Title] $Message" -ForegroundColor Yellow
        }
    }
}

# ---- 统计 ----
function Get-Stats {
    $sessions = Get-Data
    $total = ($sessions | Measure-Object -Property hours -Sum).Sum
    if (-not $total) { $total = 0 }

    $today = (Get-Date).ToString('yyyy-MM-dd')
    $todayHours = ($sessions | Where-Object { $_.date -eq $today } |
                   Measure-Object -Property hours -Sum).Sum
    if (-not $todayHours) { $todayHours = 0 }

    # 连续天数：从今天（或昨天）往回数有记录的连续日期
    $days = $sessions | ForEach-Object { $_.date } | Sort-Object -Unique -Descending
    $streak = 0
    $cursor = Get-Date
    # 如果今天还没记，允许从昨天开始算连续（今天可能还没学）
    if ($days -notcontains $cursor.ToString('yyyy-MM-dd')) {
        $cursor = $cursor.AddDays(-1)
    }
    while ($days -contains $cursor.ToString('yyyy-MM-dd')) {
        $streak++
        $cursor = $cursor.AddDays(-1)
    }

    [pscustomobject]@{
        Total      = [math]::Round($total, 1)
        Today      = [math]::Round($todayHours, 1)
        Streak     = $streak
        Remaining  = [math]::Round([math]::Max(0, $GoalHours - $total), 1)
        Percent    = [math]::Round(($total / $GoalHours) * 100, 1)
        Count      = @($sessions).Count
    }
}

# ---- 命令 ----
function Invoke-Status {
    $s = Get-Stats
    $barLen = 30
    $filled = [math]::Min($barLen, [int][math]::Round(($s.Percent / 100) * $barLen))
    $bar = ('#' * $filled) + ('.' * ($barLen - $filled))

    Write-Host ''
    Write-Host '  study-nudge  ——  ada-serve 学习进度' -ForegroundColor Cyan
    Write-Host '  ----------------------------------------'
    Write-Host ("  今天:     {0} h  (目标 {1} h)" -f $s.Today, $DailyGoal) -ForegroundColor $(if ($s.Today -ge $DailyGoal) {'Green'} else {'Yellow'})
    Write-Host ("  连续:     {0} 天" -f $s.Streak) -ForegroundColor $(if ($s.Streak -ge 3) {'Green'} else {'White'})
    Write-Host ("  累计:     {0} / {1} h  ({2}%)" -f $s.Total, $GoalHours, $s.Percent)
    Write-Host ("  [{0}]" -f $bar) -ForegroundColor Cyan
    Write-Host ("  还剩:     {0} h" -f $s.Remaining)
    Write-Host ''
    if ($s.Today -lt $DailyGoal) {
        Write-Host ("  今天还差 {0} h 达标。记一笔：.\study-nudge.ps1 log <小时> `"做了什么`"" -f ([math]::Round($DailyGoal - $s.Today,1))) -ForegroundColor DarkGray
    } else {
        Write-Host '  今天达标了，收工。' -ForegroundColor DarkGray
    }
    Write-Host ''
}

function Invoke-Log {
    if ([string]::IsNullOrWhiteSpace($Arg1)) {
        Write-Host '用法: .\study-nudge.ps1 log <小时数> "备注"' -ForegroundColor Red
        Write-Host '例:   .\study-nudge.ps1 log 1.5 "写了 rmsnorm kernel"'
        return
    }
    $hours = 0.0
    if (-not [double]::TryParse($Arg1, [ref]$hours) -or $hours -le 0) {
        Write-Host "小时数无效: '$Arg1'（应为正数，如 1.5）" -ForegroundColor Red
        return
    }
    $note = if ($Arg2) { $Arg2 } else { '' }

    $sessions = @(Get-Data)
    $sessions += [pscustomobject]@{
        date  = (Get-Date).ToString('yyyy-MM-dd')
        time  = (Get-Date).ToString('HH:mm')
        hours = [math]::Round($hours, 2)
        note  = $note
    }
    Save-Data $sessions

    Write-Host ("已记录 {0} h — {1}" -f $hours, $note) -ForegroundColor Green
    Invoke-Status
}

function Invoke-Remind {
    $s = Get-Stats
    if ($s.Today -ge $DailyGoal) {
        $title = '今天已达标 ✔'
        $msg   = "已学 $($s.Today) h，连续 $($s.Streak) 天。ada-serve 进度 $($s.Percent)%。"
    } elseif ($s.Today -gt 0) {
        $title = '再顶一把'
        $msg   = "今天学了 $($s.Today) h，离目标还差 $([math]::Round($DailyGoal - $s.Today,1)) h。连续 $($s.Streak) 天。"
    } else {
        $title = '今天还没动 ada-serve'
        $msg   = "连续 $($s.Streak) 天。别断。目标每天 $DailyGoal h，还剩 $($s.Remaining) h 到 350。"
    }
    Show-Notification -Title $title -Message $msg
    Write-Host "已弹通知: [$title] $msg" -ForegroundColor DarkGray
}

function Invoke-Install {
    $time = if ($Arg1) { $Arg1 } else { '20:00' }
    if ($time -notmatch '^\d{1,2}:\d{2}$') {
        Write-Host "时间格式无效: '$time'（应为 HH:MM，如 20:00）" -ForegroundColor Red
        return
    }
    $scriptPath = $MyInvocation.MyCommand.Path
    if (-not $scriptPath) { $scriptPath = Join-Path $ScriptDir 'study-nudge.ps1' }

    $action  = New-ScheduledTaskAction -Execute 'powershell.exe' `
        -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$scriptPath`" remind"
    $trigger = New-ScheduledTaskTrigger -Daily -At $time
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries

    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
        -Settings $settings -Description 'study-nudge 每日学习提醒' -Force | Out-Null

    Write-Host "已注册每日提醒：每天 $time 弹通知（任务名 $TaskName）" -ForegroundColor Green
    Write-Host "取消：.\study-nudge.ps1 uninstall" -ForegroundColor DarkGray
}

function Invoke-Uninstall {
    $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($existing) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Host "已取消每日提醒。" -ForegroundColor Green
    } else {
        Write-Host "没有找到已注册的提醒任务。" -ForegroundColor DarkGray
    }
}

# ---- 分发 ----
switch ($Command.ToLower()) {
    'status'    { Invoke-Status }
    'log'       { Invoke-Log }
    'remind'    { Invoke-Remind }
    'install'   { Invoke-Install }
    'uninstall' { Invoke-Uninstall }
    default {
        Write-Host "未知命令: $Command" -ForegroundColor Red
        Write-Host '可用: status | log <小时> "备注" | remind | install [HH:MM] | uninstall'
    }
}
