# Колонна: следит за логом программы TempMeter (tma1037.jar, старая плата по Bluetooth)
# и шлёт события в Home Assistant — скрипт script.kolonna_say говорит их на обеих
# станциях Алиса. Показания уходят в HA датчиками sensor.kolonna_*; пороги и кнопка
# «Запомнить рабочий уровень» — на странице HA «Колонна» (/kolonna-pult).
# Запускается сам при входе в Windows (ярлык в автозагрузке, окно свёрнуто) и молча
# ждёт, пока TempMeter начнёт писать лог. Ключ HA лежит рядом в token.txt.

$Version = '2.1.1'

# ---------- настройки ----------
$LogDir     = 'C:\Users\Dark\Desktop\колонна\tma1037.jar'
$HaUrl      = 'http://192.168.0.74:8123'

# Умные тревоги программы — рост Пара, уход от точки, «Пар 2/3 растёт», «хвосты»,
# вода — включаются переключателем на странице (input_boolean.kolonna_smart).
# 16.10 на мёде они орали весь день, поэтому по умолчанию выключены. Пороги со
# страницы HA проверяет сам, независимо от этого переключателя
$TempAlarms = $false
$RiseFast   = 0.15   # Пар вырос за 10 минут, °C
$RiseTotal  = 0.25   # Пар ушёл от рабочего уровня, °C
$WaterHot   = 65     # вода горячая, °C
$P23Rise    = 0.3    # Пар 2/3 вырос за 15 минут — «колонна не держит, убавь отбор», °C
$StallSec   = 120    # лог молчит дольше — тревога
$StallMax   = 3      # столько раз напомнить про молчащий лог, потом ждать новый погон
$BaroK      = 0.037  # поправка точки кипения, °C на мм рт. ст.
$ParCooldown = 5     # минут тишины между тревогами по Пару
$JournalDir = 'C:\Users\Dark\Desktop\колонна'   # журнал ректификации .xlsm (самый свежий)
$FlatMin    = 60     # подсказка «пошло тело»: Пар стоит столько минут...
$FlatTol    = 0.03   # ...меняясь не больше чем на столько °C (с поправкой на давление)
$TailsPar   = 0.08   # подсказка «пошли хвосты»: Пар вырос за полчаса на столько °C...
$TailsPar23 = 0.15   # ...или Пар 2/3 (он ниже, хвосты доходят до него раньше)
$TailsMinMin = 60    # без объёма тела в журнале «хвосты» не раньше стольких минут тела
$SettleMin  = 20     # после перехода на тело / смены отбора ждать минимум столько минут
$PhaseOrder = @{ 'Прогрев' = 0; 'Головы' = 1; 'Тело' = 2; 'Хвосты' = 3 }
$PushSec    = 5      # как часто отдавать показания в HA (по ним HA проверяет пороги)
$SmoothMin  = 0.5    # в HA уходит среднее за столько минут — график без зубцов
# --------------------------------

$Dir   = Split-Path -Parent $MyInvocation.MyCommand.Path
$Token = (Get-Content (Join-Path $Dir 'token.txt') -Raw).Trim()
$H     = @{ Authorization = "Bearer $Token" }
$Own   = Join-Path $Dir 'kolonna_watch.log'
$Ru    = [Globalization.CultureInfo]::GetCultureInfo('ru-RU')
$Inv   = [Globalization.CultureInfo]::InvariantCulture
$Enc   = [Text.Encoding]::GetEncoding(1251)

$mutex = New-Object Threading.Mutex($false, 'Global\kolonna_watch')
if (-not $mutex.WaitOne(0)) { Write-Host 'Уже запущено в другом окне.'; Start-Sleep 5; exit }

$Host.UI.RawUI.WindowTitle = "Колонна — уведомления v$Version"

function Note($text) {
    $line = '{0:HH:mm:ss}  {1}' -f (Get-Date), $text
    Write-Host $line
    Add-Content -Path $Own -Value $line -Encoding UTF8
}

function Num($x, $digits = 1) { ([math]::Round($x, $digits)).ToString("N$digits", $Ru) }

function Minutes([int]$n) {
    $w = if ($n % 100 -ge 11 -and $n % 100 -le 14) { 'минут' }
         elseif ($n % 10 -eq 1) { 'минуту' }
         elseif ($n % 10 -ge 2 -and $n % 10 -le 4) { 'минуты' }
         else { 'минут' }
    "$n $w"
}

function Post($path, $obj) {
    $body = [Text.Encoding]::UTF8.GetBytes(($obj | ConvertTo-Json -Compress -Depth 4))
    Invoke-RestMethod -Uri "$HaUrl$path" -Method Post -Headers $H -ContentType 'application/json; charset=utf-8' -Body $body -TimeoutSec 10 | Out-Null
}

function Get-HaAttr($id, $attr) {
    try {
        $r = Invoke-WebRequest -Uri "$HaUrl/api/states/$id" -Headers $H -TimeoutSec 5 -UseBasicParsing
        ([Text.Encoding]::UTF8.GetString($r.RawContentStream.ToArray()) | ConvertFrom-Json).attributes.$attr
    } catch { $null }
}

# ответ читаем байтами как UTF-8: PowerShell 5.1 без charset в ответе берёт
# ISO-8859-1, и «Тело» приходит кракозябрами
function Get-HaState($id) {
    try {
        $r = Invoke-WebRequest -Uri "$HaUrl/api/states/$id" -Headers $H -TimeoutSec 5 -UseBasicParsing
        ([Text.Encoding]::UTF8.GetString($r.RawContentStream.ToArray()) | ConvertFrom-Json).state
    } catch { $null }
}

# -Alarm: тревога — HA повторяет её раз в минуту, пока не нажмут «Принял»
function Say($msg, [switch]$Alarm) {
    $script = if ($Alarm) { 'kolonna_alarm' } else { 'kolonna_say' }
    Note ($(if ($Alarm) { 'ТРЕВОГА: ' } else { 'ГОЛОС: ' }) + $msg)
    # script.turn_on не ждёт конца скрипта: с громкостью и паузой длинная фраза идёт
    # дольше таймаута, и программа зря висела бы с «HA не ответил»
    try { Post '/api/services/script/turn_on' @{ entity_id = "script.$script"; variables = @{ message = $msg } } }
    catch { Note "HA не ответил: $($_.Exception.Message)" }
}

function Push-Sensors($s, $ref) {
    $list = @(
        @('sensor.kolonna_par',     'Колонна Пар',             $s.Par,   '°C',   'temperature'),
        @('sensor.kolonna_par23',   'Колонна Пар 2/3',         $s.Par23, '°C',   'temperature'),
        @('sensor.kolonna_voda',    'Колонна Вода',            $s.Water, '°C',   'temperature'),
        @('sensor.kolonna_davl',    'Колонна давление',        $s.P,     'mmHg', 'pressure'),
        @('sensor.kolonna_par_ref', 'Колонна рабочий уровень', $ref,     '°C',   'temperature')
    )
    foreach ($e in $list) {
        if ($null -eq $e[2]) { continue }
        try {
            Post "/api/states/$($e[0])" @{ state = [math]::Round($e[2], 3); attributes = @{
                friendly_name = $e[1]; unit_of_measurement = $e[3]; device_class = $e[4]; state_class = 'measurement' } }
        } catch { Note "HA датчики: $($_.Exception.Message)"; return }
    }
}

# ---------- чтение лога ----------
$cur = $null; $pos = 0; $cols = $null
$samples = New-Object Collections.Generic.List[object]
$buckets = New-Object 'Collections.Generic.SortedDictionary[datetime,object]'

function ConvertFrom-Header($line) {
    $h = $line.Split(';'); $m = @{}
    for ($i = 0; $i -lt $h.Count; $i++) {
        $n = $h[$i].Trim()
        if ($n -match '2/3|2_3')           { $m.Par23 = $i }
        elseif ($n -match 'Вод')           { $m.Water = $i }
        elseif ($n -match 'Pressure|Давл') { $m.P = $i }
        elseif ($n -match 'Пар')           { $m.Par = $i }
    }
    return $m
}

function Val($parts, $i) {
    if ($null -eq $i -or $i -ge $parts.Count) { return $null }
    $t = $parts[$i].Trim().Replace(',', '.')
    $v = 0.0
    if ([double]::TryParse($t, [Globalization.NumberStyles]::Float, $Inv, [ref]$v)) { return $v }
    return $null
}

function Read-New {
    $f = Get-ChildItem $LogDir -Filter 'tmlog-*.log' -ErrorAction SilentlyContinue |
         Sort-Object LastWriteTime | Select-Object -Last 1
    if (-not $f) { return }
    if ($f.FullName -ne $script:cur) {
        if ($script:cur) { Note "Новый файл лога: $($f.Name)" }
        $script:cur = $f.FullName; $script:pos = 0; $script:cols = $null
    }
    try { $fs = [IO.File]::Open($script:cur, 'Open', 'Read', 'ReadWrite,Delete') } catch { return }
    try {
        if ($fs.Length -lt $script:pos) { $script:pos = 0; $script:cols = $null }
        if ($fs.Length -eq $script:pos) { return }
        [void]$fs.Seek($script:pos, 'Begin')
        $buf = New-Object byte[] ($fs.Length - $script:pos)
        $n = $fs.Read($buf, 0, $buf.Length)
    } finally { $fs.Close() }
    $txt = $Enc.GetString($buf, 0, $n)
    $cut = $txt.LastIndexOf("`n")
    if ($cut -lt 0) { return }
    $script:pos += $cut + 1                     # 1251 — один байт на символ
    foreach ($line in ($txt.Substring(0, $cut) -split "`r?`n")) {
        if (-not $line) { continue }
        if ($line.StartsWith('Timestamp')) { $script:cols = ConvertFrom-Header $line; continue }
        if (-not $script:cols) { continue }
        $p = $line.Split(';')
        $ts = [datetime]::MinValue
        if (-not [datetime]::TryParseExact($p[0].Trim(), 'yyyy-MM-dd HH:mm:ss', $Inv, 'None', [ref]$ts)) { continue }
        $s = [pscustomobject]@{
            T = $ts; Par = (Val $p $script:cols.Par); Par23 = (Val $p $script:cols.Par23)
            Water = (Val $p $script:cols.Water); P = (Val $p $script:cols.P) }
        $samples.Add($s)
        # поминутные суммы Пара и давления за последний час с лишним — для подсказки
        # «пошло тело». Копятся и из уже записанного лога, поэтому после перезапуска
        # программе не нужно ждать час
        if ($null -ne $s.Par -and $null -ne $s.P) {
            $k = $ts.Date.AddHours($ts.Hour).AddMinutes($ts.Minute)
            $b = $null
            if (-not $buckets.TryGetValue($k, [ref]$b)) { $b = [pscustomobject]@{ Par = 0.0; P = 0.0; N = 0; Q = 0.0; NQ = 0 }; $buckets[$k] = $b }
            $b.Par += $s.Par; $b.P += $s.P; $b.N++
            if ($null -ne $s.Par23) { $b.Q += $s.Par23; $b.NQ++ }
        }
    }
    $old = (Get-Date).AddMinutes(-20)
    while ($samples.Count -gt 0 -and $samples[0].T -lt $old) { $samples.RemoveAt(0) }
    $oldB = (Get-Date).AddMinutes(-($FlatMin + 15))
    foreach ($k in @($buckets.Keys | Where-Object { $_ -lt $oldB })) { [void]$buckets.Remove($k) }
}

# ---------- журнал ректификации (Excel) ----------
# Норма голов = объём СС (C5) × крепость (C6) × % голов (C10), отобрано — максимум
# столбца H «Отбор мл» (нарастающий) по строкам с фазой «Головы». Видно только то,
# что Excel сохранил на диск (Ctrl+S или автосохранение раз в 10 минут)
Add-Type -AssemblyName System.IO.Compression

function Read-Journal {
    $f = Get-ChildItem $JournalDir -Recurse -Filter '*.xlsm' -ErrorAction SilentlyContinue |
         Where-Object { $_.Name -notlike '~$*' -and $_.LastWriteTime -gt (Get-Date).AddHours(-24) } |
         Sort-Object LastWriteTime | Select-Object -Last 1
    if (-not $f) { return $null }
    $ms = New-Object IO.MemoryStream
    $fs = [IO.File]::Open($f.FullName, 'Open', 'Read', 'ReadWrite,Delete')
    try { $fs.CopyTo($ms) } finally { $fs.Close() }
    $ms.Position = 0
    $zip = New-Object IO.Compression.ZipArchive($ms)
    try {
        $xml = {
            param($name)
            $e = $zip.GetEntry($name); if (-not $e) { return $null }
            $r = New-Object IO.StreamReader($e.Open(), [Text.Encoding]::UTF8)
            try { [xml]$r.ReadToEnd() } finally { $r.Close() }
        }
        $ss = @()
        $sx = & $xml 'xl/sharedStrings.xml'
        if ($sx) { foreach ($si in $sx.sst.si) { $ss += $si.InnerText } }
        $rel = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
        $sheet = (& $xml 'xl/workbook.xml').workbook.sheets.sheet | Where-Object { $_.name -eq 'Журнал процесса' }
        if (-not $sheet) { return $null }
        $rid = $sheet.GetAttribute('id', $rel)
        $target = ((& $xml 'xl/_rels/workbook.xml.rels').Relationships.Relationship | Where-Object { $_.Id -eq $rid }).Target
        $ws = & $xml ('xl/' + $target.TrimStart('/').Replace('xl/', ''))
        $cell = @{}
        foreach ($row in $ws.worksheet.sheetData.row) {
            foreach ($c in $row.c) {
                if ($null -eq $c.v -and $c.t -ne 'inlineStr') { continue }
                $cell[$c.r] = switch ($c.t) {
                    's'         { $ss[[int]$c.v] }
                    'inlineStr' { $c.is.InnerText }
                    default     { $c.v }
                }
            }
        }
        $num = { param($a) $v = 0.0; if ($cell[$a] -and [double]::TryParse($cell[$a], [Globalization.NumberStyles]::Float, $Inv, [ref]$v)) { $v } else { $null } }
        $plan = $null
        $vol = & $num 'C5'; $krep = & $num 'C6'; $pct = & $num 'C10'
        if ($vol -and $krep -and $pct) { $plan = $vol * $krep * $pct }
        # норма тела — как в журнале (H7): АС − головы − хвосты (% хвостов в C11)
        $bodyPlan = $null
        $tpct = & $num 'C11'
        if ($vol -and $krep -and $null -ne $pct -and $null -ne $tpct) { $bodyPlan = $vol * $krep * (1 - $pct - $tpct) }
        # факт фазы — максимум «Отбор мл» по её строкам, как в «ИТОГИ ОТБОРА» журнала
        $fact = @{ 'Головы' = 0.0; 'Тело' = 0.0; 'Хвосты' = 0.0 }
        $lastPhase = $null   # фаза последней строки, где вписаны температура или отбор
        for ($i = 14; $i -le 80; $i++) {
            $ph = "$($cell["C$i"])".Trim()
            if ($fact.ContainsKey($ph)) {
                $h = & $num "H$i"; if ($null -ne $h -and $h -gt $fact[$ph]) { $fact[$ph] = $h }
            }
            if ($ph -and ($null -ne (& $num "D$i") -or $null -ne (& $num "H$i"))) { $lastPhase = $ph }
        }
        return [pscustomobject]@{ Plan = $plan; Heads = $fact['Головы']; BodyPlan = $bodyPlan; Body = $fact['Тело']
                                  LastPhase = $lastPhase; Name = $f.Name; Time = $f.LastWriteTime }
    } catch { return $null } finally { $zip.Dispose() }
}

# Сохраняет открытый в Excel журнал, если в нём есть несохранённые записи — иначе
# программа их не видит. Автосохранение Excel пишет только копию для восстановления,
# сам файл не трогает. Пока в ячейке идёт ввод (Ready = false) — не лезем
function Save-OpenJournal {
    try { $xl = [Runtime.InteropServices.Marshal]::GetActiveObject('Excel.Application') } catch { return }
    try {
        if (-not $xl.Ready) { return }
        foreach ($wb in $xl.Workbooks) {
            if ($wb.Name -like 'Журнал_ректификации*' -and -not $wb.Saved -and -not $wb.ReadOnly) {
                $wb.Save()
                Note "Журнал сохранён: $($wb.Name)"
            }
        }
    } catch { } finally { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($xl) }
}

# среднее поля за окно [now-from, now-to] минут
function Avg($field, $from, $to) {
    $now = Get-Date; $a = $now.AddMinutes(-$from); $b = $now.AddMinutes(-$to)
    $v = @($samples | Where-Object { $_.T -ge $a -and $_.T -le $b -and $null -ne $_.$field } | ForEach-Object { $_.$field })
    if ($v.Count -lt 3) { return $null }
    return ($v | Measure-Object -Average).Average
}

# средний поминутный Пар или Пар 2/3, приведённый к 760 мм, за окно [now-from, now-to) минут
function Get-BucketAvg($field, $from, $to) {
    $now = Get-Date; $a = $now.AddMinutes(-$from); $z = $now.AddMinutes(-$to)
    $v = @()
    foreach ($kv in $buckets.GetEnumerator()) {
        if ($kv.Key -lt $a -or $kv.Key -ge $z) { continue }
        $x = $kv.Value
        $corr = $BaroK * ($x.P / $x.N - 760)
        if ($field -eq 'Par') { $v += $x.Par / $x.N - $corr }
        elseif ($x.NQ -gt 0) { $v += $x.Q / $x.NQ - $corr }
    }
    if ($v.Count -lt 3) { return $null }
    ($v | Measure-Object -Average).Average
}

# строка подсказки на странице «Колонна»; 'нет' — скрыть
function Set-Hint($txt) {
    try { Post '/api/states/sensor.kolonna_hint' @{ state = $txt.Substring(0, [math]::Min(250, $txt.Length))
                                                    attributes = @{ friendly_name = 'Колонна подсказка' } } } catch { }
}

# колонна перестраивается (перешли на тело, поменяли отбор): ждать, пока устоится.
# Подсказку о хвостах, сказанную в переходе, снимаем — она была ложной
function Start-Settle {
    $script:settling = $true; $script:settleFrom = Get-Date
    $script:hintSaid.tails = $false
    if ((Get-HaState 'sensor.kolonna_hint') -like '*хвосты:*') { Set-Hint 'нет' }
}

# ---------- главный цикл ----------
Note "Старт v$Version. Жду, когда TempMeter начнёт писать лог: $LogDir"
$active     = $false        # идёт погон: лог свежий
$lastLine   = [datetime]::MinValue
$stallCount = 0
$stalled    = $false
$lastStallSay = [datetime]::MinValue
$refPar = $null; $refP = $null
$lastParAlert = [datetime]::MinValue
$lastDeltaAlert = [datetime]::MinValue
$lastWaterAlert = [datetime]::MinValue
$waterHotNow = $false
$lastPush = [datetime]::MinValue
$btnSeen = Get-HaState 'input_button.kolonna_ref'
$fazaSeen = $null
$journal = $null; $journalAt = [datetime]::MinValue
$excelPhaseSeen = $null; $journalFileSeen = $null
$lastBeat = [datetime]::MinValue
$driftSaid = $false; $lastP23Say = [datetime]::MinValue
$settling = $false; $settleFrom = Get-Date; $bodyFrom = Get-Date
$hintSaid = @{}; $hintPhase = $null   # какие подсказки уже сказаны в текущей фазе
# после перезапуска не повторять то, что уже висит на странице
$prevHint = Get-HaState 'sensor.kolonna_hint'
if ($prevHint -and $prevHint -notin 'нет', 'unknown', 'unavailable') {
    $hintPhase = Get-HaState 'input_select.kolonna_faza'
    if ($prevHint -like 'Похоже, головы*') { $hintSaid.body = $true }
    if ($prevHint -like 'Тело отобрано*')   { $hintSaid.p90 = $true }
    if ($prevHint -like '*хвосты:*')        { $hintSaid.p90 = $true; $hintSaid.tails = $true }
} else { Set-Hint 'нет' }

while ($true) {
    $lastT = if ($samples.Count) { $samples[$samples.Count - 1].T } else { $null }
    Read-New
    $newest = if ($samples.Count) { $samples[$samples.Count - 1] } else { $null }
    $now = Get-Date
    if ($newest -and $newest.T -ne $lastT) { $lastLine = $newest.T }
    $silent = ($now - $lastLine).TotalSeconds

    # --- «программа жива»: раз в 30 с. Пропал сигнал посреди погона — HA сам скажет,
    # что ноут не отвечает (автоматизация kolonna_watchdog)
    if (($now - $lastBeat).TotalSeconds -ge 30) {
        $lastBeat = $now
        $st = if (-not $active) { 'ждёт' } elseif ($stalled) { 'лог молчит' } else { 'идёт' }
        try { Post '/api/states/sensor.kolonna_status' @{ state = $st; attributes = @{ friendly_name = 'Колонна программа на ноуте'; version = $Version } } } catch { }
    }

    # --- ждём начала погона ---
    if (-not $active) {
        if ($newest -and $silent -lt $StallSec) {
            $active = $true; $stalled = $false; $stallCount = 0
            $refPar = $null; $refP = $null
            $lastParAlert = [datetime]::MinValue; $lastDeltaAlert = [datetime]::MinValue
            $msg = 'Слежу за колонной.'
            if ($null -ne $newest.Par) { $msg += " Пар $(Num $newest.Par 2), вода $(Num $newest.Water 1)." }
            Say $msg
        } else { Start-Sleep -Seconds 5; continue }
    }

    # --- лог молчит ---
    if ($silent -gt $StallSec) {
        $due = (-not $stalled) -or (($now - $lastStallSay).TotalMinutes -ge 10)
        if ($due) {
            $stalled = $true; $stallCount++; $lastStallSay = $now
            if ($stallCount -lt $StallMax) {
                Say "Лог колонны не пишется уже $(Minutes ([math]::Floor($silent / 60))). Проверь блютуз и программу." -Alarm
            } else {
                Say 'Лог колонны так и молчит. Похоже, погон закончен. Замолкаю до следующего погона.'
                $active = $false
            }
        }
        Start-Sleep -Seconds 5; continue
    } elseif ($stalled) {
        $stalled = $false; $stallCount = 0
        Say 'Лог колонны снова пишется.'
    }

    $par2  = Avg 'Par' 2 0
    $p2    = Avg 'P' 2 0
    $par12 = Avg 'Par' 12 10
    $p12   = Avg 'P' 12 10
    $w2    = Avg 'Water' 2 0

    # рабочий уровень Пара — сам при старте, потом по кнопке на странице «Колонна»
    if ($null -eq $refPar -and $null -ne $par2) {
        $refPar = $par2; $refP = $p2
        Note "Рабочий уровень Пара: $(Num $refPar 2) при $(Num $refP 1) мм"
    }
    # кнопка «Поменял отбор — перезапомнить»: колонна перестраивается, ждём, пока
    # устоится, и только тогда запоминаем Пар (сразу — ловили бы переходный процесс)
    $btn = Get-HaState 'input_button.kolonna_ref'
    if ($btn -and $btn -ne $btnSeen) {
        $btnSeen = $btn
        Start-Settle
        if ($TempAlarms) { Say 'Поняла. Жду, пока колонна устоится, потом запомню Пар.' }
    }

    # переключатель умных тревог. Включили на теле — сначала ждём, пока колонна
    # устоится: точка отсчёта со старта программы могла давно устареть
    $smart = (Get-HaState 'input_boolean.kolonna_smart') -eq 'on'
    if ($smart -ne $TempAlarms) {
        $TempAlarms = $smart
        if ($smart) {
            if ($fazaSeen -eq 'Тело') { Start-Settle; Say 'Умные тревоги включены. Жду, пока колонна устоится, потом запомню Пар.' }
            else { Say 'Умные тревоги включены.' }
        } else { Say 'Умные тревоги выключены.' }
    }

    # фаза со страницы «Колонна» (или из журнала — см. ниже)
    $faza = Get-HaState 'input_select.kolonna_faza'
    if ($faza -and $faza -ne $fazaSeen) {
        if ($faza -eq 'Тело') {
            Start-Settle
            $bodyFrom = $now
            if ($null -ne $fazaSeen) {
                if ($TempAlarms) { Say 'Фаза тело. Жду, пока колонна устоится после переключения, потом запомню Пар и буду следить за хвостами.' }
                else { Say 'Фаза: тело.' }
            }
        } elseif ($null -ne $fazaSeen) {
            Say "Фаза: $($faza.ToLower())."
        }
        Note "Фаза: $faza"
        $fazaSeen = $faza
    }

    # 16.10: через 3 минуты после перехода на тело и прибавки отбора Пар 2/3 вырос
    # на 0,16 — и программа приняла это за хвосты. Теперь ждём: не меньше SettleMin
    # минут и Пар 15 минут в пределах FlatTol. Пока ждём, точка отсчёта плавает за Паром
    if ($settling -and $faza -eq 'Тело' -and $null -ne $par2) {
        $refPar = $par2; $refP = $p2
        $a5 = Get-BucketAvg 'Par' 5 0; $b5 = Get-BucketAvg 'Par' 15 10
        if (($now - $settleFrom).TotalMinutes -ge $SettleMin -and $null -ne $a5 -and $null -ne $b5 -and
            [math]::Abs($a5 - $b5) -le $FlatTol) {
            $settling = $false; $driftSaid = $false
            $lastParAlert = $now; $lastP23Say = $now
            if ($TempAlarms) { Say "Колонна устоялась. Запомнила Пар $(Num $refPar 2). Слежу за хвостами." }
        }
    }
    # уход Пара и перепад — только на теле и только когда колонна устоялась: на
    # прогреве, головах и в переходе Пар гуляет законно. HA не ответил про фазу — следим
    $parWatch = $TempAlarms -and ((-not $faza) -or ($faza -eq 'Тело' -and -not $settling))

    # --- подсказки по фазам из температуры и журнала ---
    if (($now - $journalAt).TotalMinutes -ge 2) {
        $journalAt = $now
        Save-OpenJournal
        $j = Read-Journal
        if ($j) {
            $journal = $j
            # фаза из журнала: фаза последней строки с данными. Только вперёд
            # (Головы → Тело → Хвосты), чтобы Excel не перебил выбор на странице
            # Новый журнал (другой файл, чем в прошлый раз) — новый погон: фазу берём
            # как есть, и назад тоже (вчерашнее «Тело» → сегодняшний «Прогрев»).
            # Прошлое имя файла HA помнит в атрибуте file у sensor.kolonna_golovy
            if ($null -eq $journalFileSeen) { $journalFileSeen = Get-HaAttr 'sensor.kolonna_golovy' 'file' }
            $newJournal = $journalFileSeen -and $j.Name -ne $journalFileSeen
            $journalFileSeen = $j.Name
            if ($newJournal) { $excelPhaseSeen = $null; Note "Новый журнал: $($j.Name)" }
            if ($j.LastPhase -and $PhaseOrder.ContainsKey($j.LastPhase) -and $j.LastPhase -ne $excelPhaseSeen) {
                $excelPhaseSeen = $j.LastPhase
                $haFaza = Get-HaState 'input_select.kolonna_faza'   # не $cur: это путь к логу
                if ($newJournal -or -not $haFaza -or -not $PhaseOrder.ContainsKey($haFaza) -or $PhaseOrder[$j.LastPhase] -gt $PhaseOrder[$haFaza]) {
                    try {
                        Post '/api/services/input_select/select_option' @{ entity_id = 'input_select.kolonna_faza'; option = $j.LastPhase }
                        Note "Фаза из журнала: $($j.LastPhase)"
                    } catch { }
                }
            }
            try {
                Post '/api/states/sensor.kolonna_golovy' @{ state = [math]::Round($j.Heads); attributes = @{
                    friendly_name = 'Колонна головы отобрано'; unit_of_measurement = 'мл'
                    plan = $(if ($j.Plan) { [math]::Round($j.Plan) } else { $null }); file = $j.Name
                    saved = $j.Time.ToString('HH:mm') } }
                Post '/api/states/sensor.kolonna_telo' @{ state = [math]::Round($j.Body); attributes = @{
                    friendly_name = 'Колонна тело отобрано'; unit_of_measurement = 'мл'
                    plan = $(if ($j.BodyPlan) { [math]::Round($j.BodyPlan) } else { $null }) } }
            } catch { }
        }
    }

    # подсказки живут в пределах своей фазы: сменилась фаза — строка на странице гаснет
    if ($faza -ne $hintPhase) {
        if ($hintPhase) { Set-Hint 'нет' }
        $hintPhase = $faza; $hintSaid = @{}
    }

    # головы → тело: Пар час стоит И голов не меньше нормы. Одной температуры мало:
    # 16.10 Пар стоял час и в 09:00–10:15, когда голов было 100–180 мл
    if ($faza -eq 'Головы' -and -not $hintSaid.body -and $journal -and $journal.Plan -and $journal.Heads -ge $journal.Plan) {
        $nowPar = Get-BucketAvg 'Par' 10 0; $hourPar = Get-BucketAvg 'Par' $FlatMin ($FlatMin - 10)
        if ($null -ne $nowPar -and $null -ne $hourPar -and [math]::Abs($nowPar - $hourPar) -le $FlatTol) {
            $hintSaid.body = $true
            $txt = "Похоже, головы закончились: Пар час стоит на $(Num $par2 2), голов $([math]::Round($journal.Heads)) из $([math]::Round($journal.Plan)). Проверь пробу и переключай на тело."
            Say $txt; Set-Hint $txt
        }
    }

    # тело → хвосты. Пар 2/3 ниже по колонне: фронт хвостов доходит до него раньше
    if ($faza -eq 'Тело') {
        $frac = if ($journal -and $journal.BodyPlan -and $journal.Body -gt 0) { $journal.Body / $journal.BodyPlan } else { $null }
        if (-not $hintSaid.p90 -and $null -ne $frac -and $frac -ge 0.9) {
            $hintSaid.p90 = $true
            $txt = "Тело отобрано на $([math]::Round($frac * 100)) процентов: $([math]::Round($journal.Body)) из $([math]::Round($journal.BodyPlan)). Скоро хвосты, следи за колонной."
            Say $txt; Set-Hint $txt
        }
        $dPar = $null; $d23 = $null
        $a = Get-BucketAvg 'Par' 10 0;   $b = Get-BucketAvg 'Par' 40 30
        if ($null -ne $a -and $null -ne $b) { $dPar = $a - $b }
        $a = Get-BucketAvg 'Par23' 10 0; $b = Get-BucketAvg 'Par23' 40 30
        if ($null -ne $a -and $null -ne $b) { $d23 = $a - $b }
        $rise = $TempAlarms -and (($null -ne $dPar -and $dPar -ge $TailsPar) -or ($null -ne $d23 -and $d23 -ge $TailsPar23))
        # тело в журнал не вписано — решаем по одной температуре, но не раньше часа
        # тела: в начале тела хвостов не бывает
        $volOk = if ($null -eq $frac) { ($now - $bodyFrom).TotalMinutes -ge $TailsMinMin } else { $frac -ge 0.8 }
        if (-not $settling -and -not $hintSaid.tails -and $rise -and $volOk) {
            $hintSaid.tails = $true
            $what = @()
            if ($null -ne $dPar -and $dPar -ge $TailsPar) { $what += "Пар поднялся на $(Num $dPar 2)" }
            if ($null -ne $d23 -and $d23 -ge $TailsPar23) { $what += "Пар два третьих на $(Num $d23 2)" }
            $txt = "Похоже, начинаются хвосты: $($what -join ', ') за полчаса"
            if ($null -ne $frac) { $txt += ", тела $([math]::Round($journal.Body)) из $([math]::Round($journal.BodyPlan))" }
            $txt += '. Проверь пробу.'
            Say $txt -Alarm; Set-Hint $txt
        }
    }

    $parQuiet = $parWatch -and (($now - $lastParAlert).TotalMinutes -ge $ParCooldown)

    # Рост Пара — одна фраза, без повтора до «Принял» (16.10: на мёде к концу тела
    # колонна проседала каждые 20 минут, повторы только дёргали). С повтором
    # остаются горячая вода, молчащий лог, нет связи с ноутом и пороги.
    # Тревожим только за РОСТ Пара. «Пар упал» и «перепад изменился» убраны 16.10:
    # дёргались на каждую регулировку отбора (убавил отбор — Пар падает, это не беда).
    # Точка отсчёта после тревоги НЕ переезжает: 16.10 она уехала на 77,86 вместе с
    # перегретой колонной, и следить дальше было бы не от чего

    # --- Пар: быстрый рост за 10 минут (с поправкой на давление) ---
    if ($parQuiet -and $null -ne $par2 -and $null -ne $par12) {
        $d = $par2 - $par12
        if ($null -ne $p2 -and $null -ne $p12) { $d -= $BaroK * ($p2 - $p12) }
        # сразу после «Пар 2/3 растёт» — молчим: это одно и то же событие
        if ($d -ge $RiseFast -and ($now - $lastP23Say).TotalMinutes -ge 15) {
            Say "Внимание! Пар вырос на $(Num $d 2) за 10 минут. Сейчас $(Num $par2 2)."
            $lastParAlert = $now; $parQuiet = $false
        }
    }

    # --- Пар: ушёл вверх от точки отсчёта. Один раз, снова — когда вернётся ---
    if ($null -ne $par2 -and $null -ne $refPar) {
        $d = $par2 - $refPar
        if ($null -ne $p2 -and $null -ne $refP) { $d -= $BaroK * ($p2 - $refP) }
        if ($parQuiet -and -not $driftSaid -and $d -ge $RiseTotal) {
            Say "Пар ушёл выше рабочего уровня на $(Num $d 2). Сейчас $(Num $par2 2)."
            $lastParAlert = $now; $driftSaid = $true
        } elseif ($driftSaid -and $d -lt $RiseTotal / 2) {
            $driftSaid = $false
        }
    }

    # --- Пар 2/3 растёт: колонна не держит отбор. Раньше тревоги по Пару: 16.10
    # Пар 2/3 пошёл вверх в 16:05, а Пар дошёл до тревоги только в 16:35. Не тревога,
    # одна фраза: убавить отбор — и колонна вернётся
    if ($parWatch -and ($now - $lastP23Say).TotalMinutes -ge 20) {
        $a = Get-BucketAvg 'Par23' 5 0; $b = Get-BucketAvg 'Par23' 20 15
        if ($null -ne $a -and $null -ne $b -and ($a - $b) -ge $P23Rise) {
            Say "Пар два третьих растёт: плюс $(Num ($a - $b) 2) за 15 минут. Колонна не держит отбор, убавь отбор."
            $lastP23Say = $now
        }
    }

    # --- вода горячая --- (выключено вместе с $TempAlarms: есть порог воды на странице)
    if ($TempAlarms -and $null -ne $w2) {
        if ($w2 -ge $WaterHot -and (-not $waterHotNow -or ($now - $lastWaterAlert).TotalMinutes -ge 5)) {
            Say "Вода горячая, $(Num $w2 1) градуса. Проверь охлаждение." -Alarm
            $waterHotNow = $true; $lastWaterAlert = $now
        } elseif ($waterHotNow -and $w2 -lt ($WaterHot - 2)) {
            Say "Вода в норме, $(Num $w2 1)."
            $waterHotNow = $false
        }
    }

    # --- показания в HA как датчики ---
    # среднее за 30 с: датчик дрожит на младшем бите (77,25 ↔ 77,31), на графике
    # это зубцы. Тревоги программы считают по своим средним, их это не касается
    if (($now - $lastPush).TotalSeconds -ge $PushSec) {
        $lastPush = $now
        $smooth = [pscustomobject]@{}
        foreach ($f in 'Par', 'Par23', 'Water', 'P') {
            $v = Avg $f $SmoothMin 0
            if ($null -eq $v) { $v = $newest.$f }
            $smooth | Add-Member -NotePropertyName $f -NotePropertyValue $v
        }
        Push-Sensors $smooth $refPar
    }

    Start-Sleep -Seconds 5
}
