# Колонна: следит за логом программы TempMeter (tma1037.jar, старая плата по Bluetooth)
# и шлёт события в Home Assistant — скрипт script.kolonna_say говорит их на обеих
# станциях Алиса. Показания уходят в HA датчиками sensor.kolonna_*; пороги и кнопка
# «Запомнить рабочий уровень» — на странице HA «Колонна» (/kolonna-pult).
# Запускается сам при входе в Windows (ярлык в автозагрузке, окно свёрнуто) и молча
# ждёт, пока TempMeter начнёт писать лог. Ключ HA лежит рядом в token.txt.

$Version = '1.5.1'

# ---------- настройки ----------
$LogDir     = 'C:\Users\Dark\Desktop\колонна\tma1037.jar'
$HaUrl      = 'http://192.168.0.74:8123'

$RiseFast   = 0.15   # Пар вырос (или упал) за 10 минут, °C
$RiseTotal  = 0.25   # Пар ушёл от рабочего уровня, °C
$WaterHot   = 65     # вода горячая, °C
$DeltaJump  = 0.4    # перепад Пар − Пар2/3 изменился за 10 минут, °C
$StallSec   = 120    # лог молчит дольше — тревога
$StallMax   = 3      # столько раз напомнить про молчащий лог, потом ждать новый погон
$BaroK      = 0.037  # поправка точки кипения, °C на мм рт. ст.
$ParCooldown = 5     # минут тишины между тревогами по Пару
$JournalDir = 'C:\Users\Dark\Desktop\колонна'   # журнал ректификации .xlsm (самый свежий)
$FlatMin    = 60     # подсказка «пошло тело»: Пар стоит столько минут...
$FlatTol    = 0.03   # ...меняясь не больше чем на столько °C (с поправкой на давление)
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
    try { Post "/api/services/script/$script" @{ message = $msg } }
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
        $samples.Add([pscustomobject]@{
            T = $ts; Par = (Val $p $script:cols.Par); Par23 = (Val $p $script:cols.Par23)
            Water = (Val $p $script:cols.Water); P = (Val $p $script:cols.P) })
    }
    $old = (Get-Date).AddMinutes(-20)
    while ($samples.Count -gt 0 -and $samples[0].T -lt $old) { $samples.RemoveAt(0) }
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
        $heads = 0.0
        for ($i = 14; $i -le 80; $i++) {
            if ("$($cell["C$i"])".Trim() -eq 'Головы') {
                $h = & $num "H$i"; if ($null -ne $h -and $h -gt $heads) { $heads = $h }
            }
        }
        return [pscustomobject]@{ Plan = $plan; Heads = $heads; Name = $f.Name; Time = $f.LastWriteTime }
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
$mins = New-Object Collections.Generic.List[object]   # средний Пар по минутам, для подсказки
$lastMinute = -1
$journal = $null; $journalAt = [datetime]::MinValue
$hintSaid = $false
try { Post '/api/states/sensor.kolonna_hint' @{ state = 'нет'; attributes = @{ friendly_name = 'Колонна подсказка' } } } catch { }

while ($true) {
    $lastT = if ($samples.Count) { $samples[$samples.Count - 1].T } else { $null }
    Read-New
    $newest = if ($samples.Count) { $samples[$samples.Count - 1] } else { $null }
    $now = Get-Date
    if ($newest -and $newest.T -ne $lastT) { $lastLine = $newest.T }
    $silent = ($now - $lastLine).TotalSeconds

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
    $btn = Get-HaState 'input_button.kolonna_ref'
    if ($btn -and $btn -ne $btnSeen) {
        $btnSeen = $btn
        $refPar = if ($null -ne $par2) { $par2 } else { $newest.Par }
        $refP   = if ($null -ne $p2) { $p2 } else { $newest.P }
        $lastParAlert = $now
        Say "Запомнила рабочий уровень. Пар $(Num $refPar 2)."
    }

    # фаза со страницы «Колонна»: на «Тело» точка отсчёта запоминается сама
    $faza = Get-HaState 'input_select.kolonna_faza'
    if ($faza -and $faza -ne $fazaSeen) {
        if ($null -ne $fazaSeen) {
            if ($faza -eq 'Тело') {
                $refPar = if ($null -ne $par2) { $par2 } else { $newest.Par }
                $refP   = if ($null -ne $p2) { $p2 } else { $newest.P }
                $lastParAlert = $now; $lastDeltaAlert = $now
                Say "Фаза тело. Запомнила Пар $(Num $refPar 2). Слежу за хвостами."
            } else {
                Say "Фаза: $($faza.ToLower())."
            }
        }
        Note "Фаза: $faza"
        $fazaSeen = $faza
    }
    # уход Пара и перепад — только на теле: на прогреве и головах Пар гуляет
    # законно. Если HA не ответил про фазу — следим, как раньше
    $parWatch = (-not $faza) -or ($faza -eq 'Тело')

    # --- подсказка «похоже, пошло тело»: Пар час стоит И голов не меньше нормы ---
    # Одной температуры мало: 16.10 Пар стоял час и в 09:00–10:15, при 100–180 мл голов
    if ($now.Minute -ne $lastMinute) {
        $lastMinute = $now.Minute
        $a1 = Avg 'Par' 1 0; $pp1 = Avg 'P' 1 0
        if ($null -ne $a1 -and $null -ne $pp1) {
            $mins.Add([pscustomobject]@{ T = $now; V = $a1 - $BaroK * ($pp1 - 760) })
        }
        while ($mins.Count -gt 0 -and $mins[0].T -lt $now.AddMinutes(-($FlatMin + 10))) { $mins.RemoveAt(0) }
    }
    if (($now - $journalAt).TotalMinutes -ge 2) {
        $journalAt = $now
        Save-OpenJournal
        $j = Read-Journal
        if ($j) {
            $journal = $j
            try {
                Post '/api/states/sensor.kolonna_golovy' @{ state = [math]::Round($j.Heads); attributes = @{
                    friendly_name = 'Колонна головы отобрано'; unit_of_measurement = 'мл'
                    plan = $(if ($j.Plan) { [math]::Round($j.Plan) } else { $null }); file = $j.Name
                    saved = $j.Time.ToString('HH:mm') } }
            } catch { }
        }
    }
    $flat = $false
    if ($mins.Count -gt 0 -and $mins[0].T -le $now.AddMinutes(-$FlatMin)) {
        $old = @($mins | Where-Object { $_.T -le $now.AddMinutes(-($FlatMin - 10)) } | ForEach-Object { $_.V })
        $new = @($mins | Where-Object { $_.T -ge $now.AddMinutes(-10) } | ForEach-Object { $_.V })
        if ($old.Count -ge 3 -and $new.Count -ge 3) {
            $flat = [math]::Abs(($new | Measure-Object -Average).Average - ($old | Measure-Object -Average).Average) -le $FlatTol
        }
    }
    $hintNow = $faza -eq 'Головы' -and $flat -and $journal -and $journal.Plan -and $journal.Heads -ge $journal.Plan
    if ($hintNow -and -not $hintSaid) {
        $hintSaid = $true
        $txt = "Похоже, головы закончились: Пар час стоит на $(Num $par2 2), голов $([math]::Round($journal.Heads)) из $([math]::Round($journal.Plan)). Проверь пробу и переключай на тело."
        Say $txt
        try { Post '/api/states/sensor.kolonna_hint' @{ state = $txt.Substring(0, [math]::Min(250, $txt.Length)); attributes = @{ friendly_name = 'Колонна подсказка' } } } catch { }
    } elseif ($hintSaid -and $faza -ne 'Головы') {
        $hintSaid = $false
        try { Post '/api/states/sensor.kolonna_hint' @{ state = 'нет'; attributes = @{ friendly_name = 'Колонна подсказка' } } } catch { }
    }

    $parQuiet = $parWatch -and (($now - $lastParAlert).TotalMinutes -ge $ParCooldown)

    # --- Пар: быстрое изменение за 10 минут (с поправкой на давление) ---
    if ($parQuiet -and $null -ne $par2 -and $null -ne $par12) {
        $d = $par2 - $par12
        if ($null -ne $p2 -and $null -ne $p12) { $d -= $BaroK * ($p2 - $p12) }
        if ([math]::Abs($d) -ge $RiseFast) {
            $word = if ($d -gt 0) { 'вырос' } else { 'упал' }
            Say "Внимание! Пар $word на $(Num ([math]::Abs($d)) 2) за 10 минут. Сейчас $(Num $par2 2)." -Alarm
            $lastParAlert = $now; $parQuiet = $false
            $refPar = $par2; $refP = $p2
        }
    }

    # --- Пар: медленный уход от рабочего уровня ---
    if ($parQuiet -and $null -ne $par2 -and $null -ne $refPar) {
        $d = $par2 - $refPar
        if ($null -ne $p2 -and $null -ne $refP) { $d -= $BaroK * ($p2 - $refP) }
        if ([math]::Abs($d) -ge $RiseTotal) {
            $word = if ($d -gt 0) { 'выше' } else { 'ниже' }
            Say "Пар ушёл $word рабочего уровня на $(Num ([math]::Abs($d)) 2). Сейчас $(Num $par2 2)." -Alarm
            $lastParAlert = $now
            $refPar = $par2; $refP = $p2
        }
    }

    # --- вода горячая ---
    if ($null -ne $w2) {
        if ($w2 -ge $WaterHot -and (-not $waterHotNow -or ($now - $lastWaterAlert).TotalMinutes -ge 5)) {
            Say "Вода горячая, $(Num $w2 1) градуса. Проверь охлаждение." -Alarm
            $waterHotNow = $true; $lastWaterAlert = $now
        } elseif ($waterHotNow -and $w2 -lt ($WaterHot - 2)) {
            Say "Вода в норме, $(Num $w2 1)."
            $waterHotNow = $false
        }
    }

    # --- перепад Пар − Пар2/3 ---
    $q2 = Avg 'Par23' 2 0; $q12 = Avg 'Par23' 12 10
    if ($parWatch -and $null -ne $par2 -and $null -ne $q2 -and $null -ne $par12 -and $null -ne $q12 -and
        ($now - $lastDeltaAlert).TotalMinutes -ge 10) {
        $dNow = $par2 - $q2; $dOld = $par12 - $q12
        if ([math]::Abs($dNow - $dOld) -ge $DeltaJump) {
            Say "Перепад по колонне изменился: был $(Num $dOld 1), стал $(Num $dNow 1)." -Alarm
            $lastDeltaAlert = $now
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
