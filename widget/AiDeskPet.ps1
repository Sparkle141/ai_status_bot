param(
    [int]$IntervalSeconds = 4,
    [switch]$SmokeTest
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase, System.Windows.Forms, System.Drawing

$script:ScriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$script:ProjectRoot = Split-Path -Parent $script:ScriptRoot
$script:CollectorPath = Join-Path $script:ProjectRoot 'collector\collect-ai-status.mjs'
$script:StateDir = Join-Path $env:USERPROFILE '.ai-desk-pet'
$script:StateFile = Join-Path $script:StateDir 'widget-state.json'
$script:ExternalDir = Join-Path $script:StateDir 'external'

# Single-instance guard (bypassed during SmokeTest)
$script:Mutex = $null
if (-not $SmokeTest) {
    $createdNew = $false
    $script:Mutex = New-Object System.Threading.Mutex($true, 'Local\AiDeskPet_SingleInstance_v1', [ref]$createdNew)
    if (-not $createdNew) {
        [System.Windows.Forms.MessageBox]::Show(
            'AI Desk Pet 위젯이 이미 실행 중입니다. 시스템 트레이 또는 화면 위젯을 확인해 주세요.',
            'AI Desk Pet',
            [System.Windows.Forms.MessageBoxButtons]::OK,
            [System.Windows.Forms.MessageBoxIcon]::Information
        ) | Out-Null
        return
    }
}

function Resolve-NodePath {
    $cmd = Get-Command node -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($cmd -and $cmd.Source -and (Test-Path -LiteralPath $cmd.Source)) { return $cmd.Source }

    try {
        $pkg = Get-AppxPackage -Name 'OpenAI.Codex' -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($pkg -and $pkg.InstallLocation) {
            $candidate = Join-Path $pkg.InstallLocation 'app\resources\cua_node\bin\node.exe'
            if (Test-Path -LiteralPath $candidate) { return $candidate }
        }
    } catch {}

    $cfgPath = Join-Path $env:USERPROFILE '.codex\config.toml'
    if (Test-Path -LiteralPath $cfgPath) {
        $cfgText = Get-Content -LiteralPath $cfgPath -Raw -Encoding UTF8 -ErrorAction SilentlyContinue
        if ($cfgText -match "NODE_REPL_NODE_PATH\s*=\s*'([^']+)'" -or $cfgText -match 'NODE_REPL_NODE_PATH\s*=\s*"([^"]+)"') {
            $candidate = $Matches[1]
            if (Test-Path -LiteralPath $candidate) { return $candidate }
        }
    }

    $pfNode = 'C:\Program Files\nodejs\node.exe'
    if (Test-Path -LiteralPath $pfNode) { return $pfNode }

    throw 'Node.js 실행 파일(node.exe)을 찾을 수 없습니다. PATH 또는 OpenAI Codex 앱 설치 상태를 확인해 주세요.'
}

$script:NodeExe = Resolve-NodePath

function New-Brush([string]$hex) {
    $color = [System.Windows.Media.ColorConverter]::ConvertFromString($hex)
    $b = New-Object System.Windows.Media.SolidColorBrush($color)
    $b.Freeze()
    return $b
}

function Load-WidgetState {
    $def = [pscustomobject]@{
        left = -1
        top = -1
        topmost = $true
        muted = $false
    }
    try {
        if (Test-Path -LiteralPath $script:StateFile) {
            $raw = Get-Content -LiteralPath $script:StateFile -Raw -Encoding UTF8
            $obj = $raw | ConvertFrom-Json
            if ($null -ne $obj.left) { $def.left = [double]$obj.left }
            if ($null -ne $obj.top) { $def.top = [double]$obj.top }
            if ($null -ne $obj.topmost) { $def.topmost = [bool]$obj.topmost }
            if ($null -ne $obj.muted) { $def.muted = [bool]$obj.muted }
        }
    } catch {}
    return $def
}

function Save-WidgetState {
    try {
        if (-not (Test-Path -LiteralPath $script:StateDir)) {
            New-Item -ItemType Directory -Path $script:StateDir -Force | Out-Null
        }
        $payload = @{
            left = [Math]::Round($script:PetLeft, 1)
            top = [Math]::Round($script:PetTop, 1)
            topmost = $script:IsTopmost
            muted = $script:IsMuted
        } | ConvertTo-Json -Compress
        $utf8 = [System.Text.UTF8Encoding]::new($false)
        [System.IO.File]::WriteAllText($script:StateFile, $payload, $utf8)
    } catch {}
}

function Clamp-Position([double]$left, [double]$top, [double]$width, [double]$height) {
    $wa = [System.Windows.SystemParameters]::WorkArea
    $margin = 8.0
    $maxL = [Math]::Max($wa.Left + $margin, $wa.Right - $width - $margin)
    $maxT = [Math]::Max($wa.Top + $margin, $wa.Bottom - $height - $margin)
    $clampedL = [Math]::Min([Math]::Max($left, $wa.Left + $margin), $maxL)
    $clampedT = [Math]::Min([Math]::Max($top, $wa.Top + $margin), $maxT)
    return @($clampedL, $clampedT)
}

function Get-StateTheme([string]$state) {
    switch ($state) {
        'approval' {
            return @{
                accent = '#F59E0B'; halo = '#55F59E0B'; body = '#3B280D'; border = '#FBBF24'
                badge = '!'; label = '승인 대기'; trayColor = [System.Drawing.Color]::FromArgb(245, 158, 11)
            }
        }
        'error' {
            return @{
                accent = '#EF4444'; halo = '#55EF4444'; body = '#3F1419'; border = '#F87171'
                badge = '×'; label = '오류 발생'; trayColor = [System.Drawing.Color]::FromArgb(239, 68, 68)
            }
        }
        'running' {
            return @{
                accent = '#10B981'; halo = '#4410B981'; body = '#102A25'; border = '#34D399'
                badge = '●'; label = '작업 중'; trayColor = [System.Drawing.Color]::FromArgb(16, 185, 129)
            }
        }
        'paused' {
            return @{
                accent = '#60A5FA'; halo = '#4460A5FA'; body = '#17253B'; border = '#93C5FD'
                badge = '⏸'; label = '보류/대기'; trayColor = [System.Drawing.Color]::FromArgb(96, 165, 250)
            }
        }
        'done' {
            return @{
                accent = '#22C55E'; halo = '#4422C55E'; body = '#132A1C'; border = '#4ADE80'
                badge = '✓'; label = '완료'; trayColor = [System.Drawing.Color]::FromArgb(34, 197, 94)
            }
        }
        default {
            return @{
                accent = '#94A3B8'; halo = '#2894A3B8'; body = '#1E293B'; border = '#64748B'
                badge = 'z'; label = '휴식 중'; trayColor = [System.Drawing.Color]::FromArgb(148, 163, 184)
            }
        }
    }
}

function New-TrayDotIcon([System.Drawing.Color]$fillColor) {
    $bmp = New-Object System.Drawing.Bitmap(16, 16)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.Clear([System.Drawing.Color]::Transparent)
    $bgBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(240, 15, 23, 42))
    $g.FillEllipse($bgBrush, 1, 1, 14, 14)
    $dotBrush = New-Object System.Drawing.SolidBrush($fillColor)
    $g.FillEllipse($dotBrush, 3, 3, 10, 10)
    $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(200, 255, 255, 255), 1)
    $g.DrawEllipse($pen, 1, 1, 14, 14)
    $hIcon = $bmp.GetHicon()
    $icon = [System.Drawing.Icon]::FromHandle($hIcon).Clone()
    $pen.Dispose(); $dotBrush.Dispose(); $bgBrush.Dispose(); $g.Dispose(); $bmp.Dispose()
    return $icon
}

# Build XAML UI
[xml]$xaml = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="AI Desk Pet"
        AllowsTransparency="True"
        WindowStyle="None"
        Background="Transparent"
        Topmost="True"
        ShowInTaskbar="False"
        SizeToContent="WidthAndHeight"
        ResizeMode="NoResize"
        FontFamily="Malgun Gothic, Segoe UI">
    <Window.Resources>
        <Style x:Key="IconBtn" TargetType="Button">
            <Setter Property="Background" Value="#1E293B"/>
            <Setter Property="Foreground" Value="#CBD5E1"/>
            <Setter Property="BorderBrush" Value="#334155"/>
            <Setter Property="BorderThickness" Value="1"/>
            <Setter Property="Padding" Value="7,3"/>
            <Setter Property="FontSize" Value="11"/>
            <Setter Property="Cursor" Value="Hand"/>
            <Setter Property="Template">
                <Setter.Value>
                    <ControlTemplate TargetType="Button">
                        <Border x:Name="Bd" Background="{TemplateBinding Background}" BorderBrush="{TemplateBinding BorderBrush}"
                                BorderThickness="{TemplateBinding BorderThickness}" CornerRadius="7" Padding="{TemplateBinding Padding}">
                            <ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center"/>
                        </Border>
                        <ControlTemplate.Triggers>
                            <Trigger Property="IsMouseOver" Value="True">
                                <Setter TargetName="Bd" Property="Background" Value="#334155"/>
                            </Trigger>
                        </ControlTemplate.Triggers>
                    </ControlTemplate>
                </Setter.Value>
            </Setter>
        </Style>
    </Window.Resources>

    <Grid Margin="6">
        <!-- COMPACT FLOATING PET VIEW -->
        <StackPanel x:Name="CompactView" Orientation="Horizontal" VerticalAlignment="Center" Cursor="Hand"
                    Background="#01000000">
            <Grid Width="66" Height="66" Margin="0,0,4,0">
                <Grid.RenderTransform>
                    <TransformGroup>
                        <TranslateTransform x:Name="PetTranslate" X="0" Y="0"/>
                        <RotateTransform x:Name="PetRotate" Angle="0" CenterX="33" CenterY="38"/>
                    </TransformGroup>
                </Grid.RenderTransform>
                <Ellipse x:Name="PetHalo" Width="62" Height="62" Fill="#4410B981" HorizontalAlignment="Center" VerticalAlignment="Center"/>
                <Canvas Width="66" Height="66">
                    <!-- Antenna -->
                    <Line x:Name="AntennaStem" X1="33" Y1="17" X2="33" Y2="9" Stroke="#94A3B8" StrokeThickness="2.2" StrokeStartLineCap="Round" StrokeEndLineCap="Round"/>
                    <Ellipse x:Name="AntennaOrb" Canvas.Left="28.5" Canvas.Top="4" Width="9" Height="9" Fill="#10B981" Stroke="#FFFFFF" StrokeThickness="1.2"/>
                    <!-- Ears -->
                    <Rectangle x:Name="EarL" Canvas.Left="7" Canvas.Top="29" Width="6" Height="13" RadiusX="3" RadiusY="3" Fill="#64748B"/>
                    <Rectangle x:Name="EarR" Canvas.Left="53" Canvas.Top="29" Width="6" Height="13" RadiusX="3" RadiusY="3" Fill="#64748B"/>
                    <!-- Body -->
                    <Rectangle x:Name="PetBody" Canvas.Left="11" Canvas.Top="17" Width="44" Height="39" RadiusX="14" RadiusY="14" Fill="#102A25" Stroke="#34D399" StrokeThickness="2"/>
                    <!-- Visor -->
                    <Rectangle Canvas.Left="16" Canvas.Top="23" Width="34" Height="22" RadiusX="8" RadiusY="8" Fill="#0B1120"/>
                    <!-- Normal / Running Eyes -->
                    <Ellipse x:Name="EyeL" Canvas.Left="22" Canvas.Top="29" Width="6" Height="7" Fill="#34D399"/>
                    <Ellipse x:Name="EyeR" Canvas.Left="38" Canvas.Top="29" Width="6" Height="7" Fill="#34D399"/>
                    <!-- Happy Eyes (^ ^) -->
                    <Path x:Name="HappyEyeL" Data="M 21,34 Q 25,28 29,34" Stroke="#4ADE80" StrokeThickness="2.2" StrokeStartLineCap="Round" StrokeEndLineCap="Round" Visibility="Collapsed"/>
                    <Path x:Name="HappyEyeR" Data="M 37,34 Q 41,28 45,34" Stroke="#4ADE80" StrokeThickness="2.2" StrokeStartLineCap="Round" StrokeEndLineCap="Round" Visibility="Collapsed"/>
                    <!-- Sleep Eyes (- -) -->
                    <Line x:Name="SleepEyeL" X1="21" Y1="33" X2="28" Y2="33" Stroke="#94A3B8" StrokeThickness="2.2" StrokeStartLineCap="Round" StrokeEndLineCap="Round" Visibility="Collapsed"/>
                    <Line x:Name="SleepEyeR" X1="38" Y1="33" X2="45" Y2="33" Stroke="#94A3B8" StrokeThickness="2.2" StrokeStartLineCap="Round" StrokeEndLineCap="Round" Visibility="Collapsed"/>
                    <!-- Error Eyes (X X) -->
                    <Path x:Name="ErrorEyes" Data="M 22,29 L 28,35 M 28,29 L 22,35 M 38,29 L 44,35 M 44,29 L 38,35" Stroke="#F87171" StrokeThickness="2.2" StrokeStartLineCap="Round" Visibility="Collapsed"/>
                    <!-- Cheeks -->
                    <Ellipse x:Name="CheekL" Canvas.Left="18" Canvas.Top="38" Width="5" Height="3" Fill="#55F472B6"/>
                    <Ellipse x:Name="CheekR" Canvas.Left="43" Canvas.Top="38" Width="5" Height="3" Fill="#55F472B6"/>
                    <!-- Mouth -->
                    <Path x:Name="MouthPath" Data="M 29,40 Q 33,43 37,40" Stroke="#94A3B8" StrokeThickness="1.8" StrokeStartLineCap="Round" StrokeEndLineCap="Round"/>
                    <!-- Little Feet -->
                    <Rectangle Canvas.Left="20" Canvas.Top="55" Width="8" Height="4" RadiusX="2" RadiusY="2" Fill="#475569"/>
                    <Rectangle Canvas.Left="38" Canvas.Top="55" Width="8" Height="4" RadiusX="2" RadiusY="2" Fill="#475569"/>
                </Canvas>
                <!-- Floating Status Badge -->
                <Border x:Name="PetBadge" HorizontalAlignment="Right" VerticalAlignment="Top" Margin="0,4,1,0"
                        MinWidth="18" Height="18" CornerRadius="9" Background="#10B981" BorderBrush="#0F172A" BorderThickness="1.5" Padding="4,0">
                    <TextBlock x:Name="PetBadgeText" Text="●" Foreground="#FFFFFF" FontSize="10" FontWeight="Bold"
                               HorizontalAlignment="Center" VerticalAlignment="Center"/>
                </Border>
            </Grid>

            <!-- Compact Status Pill -->
            <Border x:Name="CompactPill" Background="#EB0F172A" BorderBrush="#4094A3B8" BorderThickness="1.2"
                    CornerRadius="14" Padding="11,7" VerticalAlignment="Center" MaxWidth="270">
                <Border.Effect>
                    <DropShadowEffect Color="#000000" BlurRadius="12" ShadowDepth="2" Opacity="0.45"/>
                </Border.Effect>
                <StackPanel>
                    <StackPanel Orientation="Horizontal" VerticalAlignment="Center">
                        <Ellipse x:Name="CompactDot" Width="8" Height="8" Fill="#10B981" Margin="0,0,6,0" VerticalAlignment="Center"/>
                        <TextBlock x:Name="CompactStateText" Text="확인 중..." Foreground="#F8FAFC" FontSize="12.5" FontWeight="SemiBold"/>
                        <TextBlock Text=" ▾" Foreground="#94A3B8" FontSize="10" VerticalAlignment="Center" Margin="3,0,0,0"/>
                    </StackPanel>
                    <TextBlock x:Name="CompactQuotaText" Text="로컬 데이터 수집 중" Foreground="#94A3B8" FontSize="10.5"
                               Margin="0,2,0,0" TextTrimming="CharacterEllipsis"/>
                </StackPanel>
            </Border>
        </StackPanel>

        <!-- EXPANDED DASHBOARD VIEW -->
        <Border x:Name="ExpandedView" Visibility="Collapsed" Width="430" Background="#F50B1220"
                BorderBrush="#334155" BorderThickness="1.2" CornerRadius="16" Padding="14">
            <Border.Effect>
                <DropShadowEffect Color="#000000" BlurRadius="22" ShadowDepth="4" Opacity="0.6"/>
            </Border.Effect>
            <StackPanel>
                <!-- Header (draggable) -->
                <Grid x:Name="ExpandedHeader" Background="#01000000" Cursor="SizeAll" Margin="0,0,0,8">
                    <Grid.ColumnDefinitions>
                        <ColumnDefinition Width="*"/>
                        <ColumnDefinition Width="Auto"/>
                    </Grid.ColumnDefinitions>
                    <StackPanel Orientation="Horizontal" VerticalAlignment="Center">
                        <Ellipse x:Name="HeaderDot" Width="10" Height="10" Fill="#10B981" Margin="0,0,7,0"/>
                        <TextBlock Text="AI Desk Pet" Foreground="#F8FAFC" FontSize="14" FontWeight="Bold" VerticalAlignment="Center"/>
                        <Border x:Name="HeaderStateBadge" Background="#1E293B" BorderBrush="#334155" BorderThickness="1"
                                CornerRadius="8" Padding="7,2" Margin="8,0,0,0" VerticalAlignment="Center">
                            <TextBlock x:Name="HeaderStateText" Text="휴식 중" Foreground="#E2E8F0" FontSize="10.5" FontWeight="SemiBold"/>
                        </Border>
                    </StackPanel>
                    <StackPanel Grid.Column="1" Orientation="Horizontal" VerticalAlignment="Center">
                        <Button x:Name="BtnRefresh" Content="↻" ToolTip="지금 새로고침" Style="{StaticResource IconBtn}" Margin="0,0,4,0"/>
                        <Button x:Name="BtnTopmost" Content="📌" ToolTip="항상 위(Topmost) 전환" Style="{StaticResource IconBtn}" Margin="0,0,4,0"/>
                        <Button x:Name="BtnMute" Content="🔔" ToolTip="승인/오류 알림 토스트 켜기/끄기" Style="{StaticResource IconBtn}" Margin="0,0,4,0"/>
                        <Button x:Name="BtnCollapse" Content="접기 ▴" ToolTip="펫 미니 모드로 접기" Style="{StaticResource IconBtn}"/>
                    </StackPanel>
                </Grid>

                <!-- Pet Speech Summary -->
                <Border Background="#131F33" BorderBrush="#243247" BorderThickness="1" CornerRadius="10" Padding="10,7" Margin="0,0,0,10">
                    <TextBlock x:Name="PetSpeechText" Text="데이터를 불러오는 중입니다..." Foreground="#E2E8F0" FontSize="11.5" TextWrapping="Wrap"/>
                </Border>

                <!-- Provider Quota Strip -->
                <TextBlock Text="프로바이더 · 잔여 사용량" Foreground="#94A3B8" FontSize="10.5" FontWeight="SemiBold" Margin="2,0,0,5"/>
                <WrapPanel x:Name="ProvidersPanel" Margin="0,0,0,10"/>

                <!-- Filter Tabs -->
                <Grid Margin="0,0,0,8">
                    <StackPanel Orientation="Horizontal">
                        <Button x:Name="TabAll" Content="전체" Style="{StaticResource IconBtn}" Margin="0,0,5,0"/>
                        <Button x:Name="TabActive" Content="진행·대기" Style="{StaticResource IconBtn}" Margin="0,0,5,0"/>
                        <Button x:Name="TabAlert" Content="승인·오류" Style="{StaticResource IconBtn}" Margin="0,0,5,0"/>
                        <Button x:Name="TabDone" Content="완료" Style="{StaticResource IconBtn}"/>
                    </StackPanel>
                </Grid>

                <!-- Task List -->
                <ScrollViewer MaxHeight="275" VerticalScrollBarVisibility="Auto" HorizontalScrollBarVisibility="Disabled">
                    <StackPanel x:Name="TasksPanel"/>
                </ScrollViewer>

                <!-- Footer -->
                <Grid Margin="0,10,0,0">
                    <Grid.ColumnDefinitions>
                        <ColumnDefinition Width="*"/>
                        <ColumnDefinition Width="Auto"/>
                    </Grid.ColumnDefinitions>
                    <TextBlock x:Name="FooterInfoText" Text="업데이트 대기 중 · 무토큰" Foreground="#64748B" FontSize="10.5" VerticalAlignment="Center"/>
                    <StackPanel Grid.Column="1" Orientation="Horizontal">
                        <Button x:Name="BtnExternalDir" Content="외부 연동 폴더" Style="{StaticResource IconBtn}" Margin="0,0,4,0"/>
                        <Button x:Name="BtnQuit" Content="종료" Style="{StaticResource IconBtn}"/>
                    </StackPanel>
                </Grid>
            </StackPanel>
        </Border>
    </Grid>
</Window>
'@

$reader = New-Object System.Xml.XmlNodeReader($xaml)
$script:Window = [Windows.Markup.XamlReader]::Load($reader)

function Get-El([string]$name) {
    return $script:Window.FindName($name)
}

$elCompactView = Get-El 'CompactView'
$elExpandedView = Get-El 'ExpandedView'
$elExpandedHeader = Get-El 'ExpandedHeader'
$elPetTranslate = Get-El 'PetTranslate'
$elPetRotate = Get-El 'PetRotate'
$elPetHalo = Get-El 'PetHalo'
$elAntennaOrb = Get-El 'AntennaOrb'
$elPetBody = Get-El 'PetBody'
$elEyeL = Get-El 'EyeL'
$elEyeR = Get-El 'EyeR'
$elHappyEyeL = Get-El 'HappyEyeL'
$elHappyEyeR = Get-El 'HappyEyeR'
$elSleepEyeL = Get-El 'SleepEyeL'
$elSleepEyeR = Get-El 'SleepEyeR'
$elErrorEyes = Get-El 'ErrorEyes'
$elMouthPath = Get-El 'MouthPath'
$elPetBadge = Get-El 'PetBadge'
$elPetBadgeText = Get-El 'PetBadgeText'
$elCompactPill = Get-El 'CompactPill'
$elCompactDot = Get-El 'CompactDot'
$elCompactStateText = Get-El 'CompactStateText'
$elCompactQuotaText = Get-El 'CompactQuotaText'
$elHeaderDot = Get-El 'HeaderDot'
$elHeaderStateBadge = Get-El 'HeaderStateBadge'
$elHeaderStateText = Get-El 'HeaderStateText'
$elPetSpeechText = Get-El 'PetSpeechText'
$elProvidersPanel = Get-El 'ProvidersPanel'
$elTasksPanel = Get-El 'TasksPanel'
$elFooterInfoText = Get-El 'FooterInfoText'
$elBtnRefresh = Get-El 'BtnRefresh'
$elBtnTopmost = Get-El 'BtnTopmost'
$elBtnMute = Get-El 'BtnMute'
$elBtnCollapse = Get-El 'BtnCollapse'
$elBtnExternalDir = Get-El 'BtnExternalDir'
$elBtnQuit = Get-El 'BtnQuit'
$elTabAll = Get-El 'TabAll'
$elTabActive = Get-El 'TabActive'
$elTabAlert = Get-El 'TabAlert'
$elTabDone = Get-El 'TabDone'

$saved = Load-WidgetState
$wa = [System.Windows.SystemParameters]::WorkArea
$script:PetLeft = if ($saved.left -ge 0) { $saved.left } else { $wa.Right - 340 }
$script:PetTop = if ($saved.top -ge 0) { $saved.top } else { $wa.Bottom - 110 }
$clampedInit = Clamp-Position $script:PetLeft $script:PetTop 330 82
$script:PetLeft = $clampedInit[0]
$script:PetTop = $clampedInit[1]
$script:Window.Left = $script:PetLeft
$script:Window.Top = $script:PetTop

$script:IsTopmost = [bool]$saved.topmost
$script:IsMuted = [bool]$saved.muted
$script:Window.Topmost = $script:IsTopmost
$script:IsExpanded = $false
$script:CurrentState = 'idle'
$script:ActiveFilter = 'all'
$script:LatestSnapshot = $null
$script:SeenAlerts = New-Object 'System.Collections.Generic.HashSet[string]'
$script:IsFirstSnapshot = $true
$script:AnimTick = 0

function Update-HeaderToggles {
    $elBtnTopmost.Content = if ($script:IsTopmost) { '📌' } else { '📍' }
    $elBtnTopmost.Foreground = if ($script:IsTopmost) { New-Brush '#38BDF8' } else { New-Brush '#64748B' }
    $elBtnMute.Content = if ($script:IsMuted) { '🔕' } else { '🔔' }
    $elBtnMute.Foreground = if ($script:IsMuted) { New-Brush '#64748B' } else { New-Brush '#FBBF24' }
    $script:Window.Topmost = $script:IsTopmost
}
Update-HeaderToggles

function Apply-PetVisualState([string]$state) {
    $script:CurrentState = $state
    $t = Get-StateTheme $state
    $accentBrush = New-Brush $t.accent
    $haloBrush = New-Brush $t.halo
    $bodyBrush = New-Brush $t.body
    $borderBrush = New-Brush $t.border

    $elPetHalo.Fill = $haloBrush
    $elAntennaOrb.Fill = $accentBrush
    $elPetBody.Fill = $bodyBrush
    $elPetBody.Stroke = $borderBrush
    $elPetBadge.Background = $accentBrush
    $elPetBadgeText.Text = $t.badge
    $elCompactDot.Fill = $accentBrush
    $elCompactPill.BorderBrush = $borderBrush
    $elHeaderDot.Fill = $accentBrush
    $elHeaderStateBadge.BorderBrush = $borderBrush

    # Reset eye visibility
    $elEyeL.Visibility = 'Collapsed'
    $elEyeR.Visibility = 'Collapsed'
    $elHappyEyeL.Visibility = 'Collapsed'
    $elHappyEyeR.Visibility = 'Collapsed'
    $elSleepEyeL.Visibility = 'Collapsed'
    $elSleepEyeR.Visibility = 'Collapsed'
    $elErrorEyes.Visibility = 'Collapsed'

    switch ($state) {
        'error' {
            $elErrorEyes.Visibility = 'Visible'
            $elMouthPath.Data = [System.Windows.Media.Geometry]::Parse('M 28,42 Q 33,38 38,42')
        }
        'done' {
            $elHappyEyeL.Visibility = 'Visible'
            $elHappyEyeR.Visibility = 'Visible'
            $elMouthPath.Data = [System.Windows.Media.Geometry]::Parse('M 28,39 Q 33,44 38,39')
        }
        'idle' {
            $elSleepEyeL.Visibility = 'Visible'
            $elSleepEyeR.Visibility = 'Visible'
            $elMouthPath.Data = [System.Windows.Media.Geometry]::Parse('M 30,41 L 36,41')
        }
        'approval' {
            $elEyeL.Visibility = 'Visible'; $elEyeR.Visibility = 'Visible'
            $elEyeL.Fill = $borderBrush; $elEyeR.Fill = $borderBrush
            $elMouthPath.Data = [System.Windows.Media.Geometry]::Parse('M 30,40 A 3,3 0 1 1 36,40 A 3,3 0 1 1 30,40')
        }
        default {
            $elEyeL.Visibility = 'Visible'; $elEyeR.Visibility = 'Visible'
            $elEyeL.Fill = $borderBrush; $elEyeR.Fill = $borderBrush
            $elMouthPath.Data = [System.Windows.Media.Geometry]::Parse('M 29,40 Q 33,43 37,40')
        }
    }
}

# Tray Icon
$script:NotifyIcon = New-Object System.Windows.Forms.NotifyIcon
$script:TrayIconHandle = New-TrayDotIcon ([System.Drawing.Color]::FromArgb(148, 163, 184))
$script:NotifyIcon.Icon = $script:TrayIconHandle
$script:NotifyIcon.Text = 'AI Desk Pet — 로컬 AI 작업 모니터'
$script:NotifyIcon.Visible = $true

function Update-TrayState([string]$state, [string]$speech) {
    $t = Get-StateTheme $state
    try {
        $old = $script:TrayIconHandle
        $script:TrayIconHandle = New-TrayDotIcon $t.trayColor
        $script:NotifyIcon.Icon = $script:TrayIconHandle
        if ($old) { $old.Dispose() }
        $shortTip = if ($speech.Length -gt 58) { $speech.Substring(0, 57) + '…' } else { $speech }
        $script:NotifyIcon.Text = "AI Desk Pet: $shortTip"
    } catch {}
}

function Set-ExpandedMode([bool]$expand) {
    $script:IsExpanded = $expand
    if ($expand) {
        $script:PetLeft = $script:Window.Left
        $script:PetTop = $script:Window.Top
        $elCompactView.Visibility = 'Collapsed'
        $elExpandedView.Visibility = 'Visible'
        $script:Window.UpdateLayout()
        $w = [Math]::Max(442, $script:Window.ActualWidth)
        $h = [Math]::Max(320, $script:Window.ActualHeight)
        $clamped = Clamp-Position $script:PetLeft $script:PetTop $w $h
        $script:Window.Left = $clamped[0]
        $script:Window.Top = $clamped[1]
        Render-Dashboard
    } else {
        $elExpandedView.Visibility = 'Collapsed'
        $elCompactView.Visibility = 'Visible'
        $script:Window.UpdateLayout()
        $clamped = Clamp-Position $script:PetLeft $script:PetTop 330 82
        $script:Window.Left = $clamped[0]
        $script:Window.Top = $clamped[1]
    }
}

function Update-FilterButtons {
    $c = if ($script:LatestSnapshot) { $script:LatestSnapshot.counts } else { $null }
    $nAll = if ($c) { [int]$c.total } else { 0 }
    $nActive = if ($c) { [int]$c.running + [int]$c.paused } else { 0 }
    $nAlert = if ($c) { [int]$c.approval + [int]$c.error } else { 0 }
    $nDone = if ($c) { [int]$c.done } else { 0 }

    $elTabAll.Content = "전체 ($nAll)"
    $elTabActive.Content = "진행·보류 ($nActive)"
    $elTabAlert.Content = "승인·오류 ($nAlert)"
    $elTabDone.Content = "완료 ($nDone)"

    $pairs = @(
        @($elTabAll, 'all'),
        @($elTabActive, 'active'),
        @($elTabAlert, 'alert'),
        @($elTabDone, 'done')
    )
    foreach ($p in $pairs) {
        $btn = $p[0]; $key = $p[1]
        if ($script:ActiveFilter -eq $key) {
            $btn.Background = New-Brush '#2563EB'
            $btn.BorderBrush = New-Brush '#60A5FA'
            $btn.Foreground = New-Brush '#FFFFFF'
        } else {
            $btn.Background = New-Brush '#1E293B'
            $btn.BorderBrush = New-Brush '#334155'
            $btn.Foreground = New-Brush '#CBD5E1'
        }
    }
}

function Render-Dashboard {
    $snap = $script:LatestSnapshot
    Update-FilterButtons
    if (-not $snap) { return }

    $theme = Get-StateTheme $snap.overallState
    $elHeaderStateText.Text = $theme.label
    $elPetSpeechText.Text = $snap.petSpeech
    $elFooterInfoText.Text = "갱신: $($snap.generatedAtKst.Substring(11, 8)) KST · ${IntervalSeconds}초 주기 · 무토큰"

    # Providers Strip
    $elProvidersPanel.Children.Clear()
    foreach ($p in $snap.providers) {
        $card = New-Object System.Windows.Controls.Border
        $card.Width = 128
        $card.Margin = New-Object System.Windows.Thickness(0, 0, 6, 6)
        $card.Padding = New-Object System.Windows.Thickness(9, 7, 9, 7)
        $card.CornerRadius = New-Object System.Windows.CornerRadius(10)
        $card.Background = New-Brush '#111C2E'
        $card.BorderBrush = New-Brush '#243247'
        $card.BorderThickness = New-Object System.Windows.Thickness(1)

        $sp = New-Object System.Windows.Controls.StackPanel

        # Row 1: Dot + Name + Process state
        $r1 = New-Object System.Windows.Controls.Grid
        $dot = New-Object System.Windows.Shapes.Ellipse
        $dot.Width = 7; $dot.Height = 7
        $dot.Fill = New-Brush $(if ($p.processState -eq 'running') { '#10B981' } elseif ($p.processState -eq 'paused') { '#60A5FA' } else { '#64748B' })
        $dot.HorizontalAlignment = 'Left'; $dot.VerticalAlignment = 'Center'
        $r1.Children.Add($dot) | Out-Null

        $lblName = New-Object System.Windows.Controls.TextBlock
        $lblName.Text = $p.name
        $lblName.Foreground = New-Brush '#F1F5F9'
        $lblName.FontSize = 11.5; $lblName.FontWeight = 'Bold'
        $lblName.Margin = New-Object System.Windows.Thickness(12, 0, 0, 0)
        $r1.Children.Add($lblName) | Out-Null

        $lblProc = New-Object System.Windows.Controls.TextBlock
        $lblProc.Text = if ($p.processState -eq 'running') { 'ON' } elseif ($p.processState -eq 'paused') { '대기' } else { 'OFF' }
        $lblProc.Foreground = New-Brush $(if ($p.processState -eq 'running') { '#34D399' } else { '#64748B' })
        $lblProc.FontSize = 9.5; $lblProc.FontWeight = 'SemiBold'
        $lblProc.HorizontalAlignment = 'Right'; $lblProc.VerticalAlignment = 'Center'
        $r1.Children.Add($lblProc) | Out-Null
        $sp.Children.Add($r1) | Out-Null

        # Row 2: Quota value
        $q = $p.quota
        $r2 = New-Object System.Windows.Controls.Grid
        $r2.Margin = New-Object System.Windows.Thickness(0, 4, 0, 2)
        $lblQName = New-Object System.Windows.Controls.TextBlock
        $lblQName.Text = if ($q -and $q.primaryLabel) { $q.primaryLabel } else { '잔여량' }
        $lblQName.Foreground = New-Brush '#94A3B8'
        $lblQName.FontSize = 10
        $r2.Children.Add($lblQName) | Out-Null

        $lblQVal = New-Object System.Windows.Controls.TextBlock
        $lblQVal.Text = if ($q -and $q.primaryValueText) { $q.primaryValueText } else { '-' }
        $lblQVal.FontSize = 11; $lblQVal.FontWeight = 'Bold'
        $lblQVal.HorizontalAlignment = 'Right'
        if ($q -and $q.available -and $null -ne $q.remainingPct) {
            $rem = [double]$q.remainingPct
            $lblQVal.Foreground = New-Brush $(if ($rem -ge 50) { '#34D399' } elseif ($rem -ge 20) { '#FBBF24' } else { '#F87171' })
        } else {
            $lblQVal.Foreground = New-Brush '#93C5FD'
        }
        $r2.Children.Add($lblQVal) | Out-Null
        $sp.Children.Add($r2) | Out-Null

        # Progress Bar
        $barBg = New-Object System.Windows.Controls.Border
        $barBg.Height = 5; $barBg.CornerRadius = New-Object System.Windows.CornerRadius(2.5)
        $barBg.Background = New-Brush '#1E293B'; $barBg.Margin = New-Object System.Windows.Thickness(0, 1, 0, 3)
        if ($q -and $q.available -and $null -ne $q.remainingPct) {
            $rem = [Math]::Max(0, [Math]::Min(100, [double]$q.remainingPct))
            $barFill = New-Object System.Windows.Controls.Border
            $barFill.Height = 5; $barFill.CornerRadius = New-Object System.Windows.CornerRadius(2.5)
            $barFill.HorizontalAlignment = 'Left'
            $barFill.Width = [Math]::Max(3, [Math]::Round(108 * ($rem / 100.0), 1))
            $barFill.Background = New-Brush $(if ($rem -ge 50) { '#10B981' } elseif ($rem -ge 20) { '#F59E0B' } else { '#EF4444' })
            $barBg.Child = $barFill
        } else {
            $barFill = New-Object System.Windows.Controls.Border
            $barFill.Height = 5; $barFill.CornerRadius = New-Object System.Windows.CornerRadius(2.5)
            $barFill.HorizontalAlignment = 'Left'; $barFill.Width = 40
            $barFill.Background = New-Brush '#3B82F6'
            $barBg.Child = $barFill
        }
        $sp.Children.Add($barBg) | Out-Null

        # Row 3: Reset / Sub-detail
        $subTxt = if ($q -and $q.secondaryText) { $q.secondaryText } elseif ($q -and $q.resetText) { $q.resetText } else { $p.processDetail }
        $lblSub = New-Object System.Windows.Controls.TextBlock
        $lblSub.Text = $subTxt
        $lblSub.Foreground = New-Brush '#64748B'
        $lblSub.FontSize = 9.5
        $lblSub.TextTrimming = 'CharacterEllipsis'
        $lblSub.ToolTip = "$($p.processDetail)`n$($q.resetText)`n$($p.note)"
        $sp.Children.Add($lblSub) | Out-Null

        $card.Child = $sp
        $elProvidersPanel.Children.Add($card) | Out-Null
    }

    # Tasks List
    $elTasksPanel.Children.Clear()
    $filtered = @()
    foreach ($t in $snap.tasks) {
        $include = switch ($script:ActiveFilter) {
            'active' { $t.status -eq 'running' -or $t.status -eq 'paused' }
            'alert'  { $t.status -eq 'approval' -or $t.status -eq 'error' }
            'done'   { $t.status -eq 'done' }
            default  { $true }
        }
        if ($include) { $filtered += $t }
    }

    if ($filtered.Count -eq 0) {
        $empty = New-Object System.Windows.Controls.TextBlock
        $empty.Text = '표시할 작업이 없습니다.'
        $empty.Foreground = New-Brush '#64748B'
        $empty.FontSize = 11.5
        $empty.HorizontalAlignment = 'Center'
        $empty.Margin = New-Object System.Windows.Thickness(0, 22, 0, 22)
        $elTasksPanel.Children.Add($empty) | Out-Null
        return
    }

    foreach ($t in ($filtered | Select-Object -First 25)) {
        $stTheme = Get-StateTheme $t.status
        $tCard = New-Object System.Windows.Controls.Border
        $tCard.Background = New-Brush '#111C2E'
        $tCard.BorderBrush = New-Brush $(if ($t.status -eq 'approval' -or $t.status -eq 'error') { $stTheme.accent } else { '#243247' })
        $tCard.BorderThickness = New-Object System.Windows.Thickness(1)
        $tCard.CornerRadius = New-Object System.Windows.CornerRadius(10)
        $tCard.Padding = New-Object System.Windows.Thickness(10, 8, 10, 8)
        $tCard.Margin = New-Object System.Windows.Thickness(0, 0, 4, 6)

        $tsp = New-Object System.Windows.Controls.StackPanel

        # Top meta row
        $topRow = New-Object System.Windows.Controls.Grid
        $leftTags = New-Object System.Windows.Controls.StackPanel
        $leftTags.Orientation = 'Horizontal'

        $stPill = New-Object System.Windows.Controls.Border
        $stPill.Background = New-Brush $stTheme.body
        $stPill.BorderBrush = New-Brush $stTheme.accent
        $stPill.BorderThickness = New-Object System.Windows.Thickness(1)
        $stPill.CornerRadius = New-Object System.Windows.CornerRadius(6)
        $stPill.Padding = New-Object System.Windows.Thickness(5, 1, 5, 1)
        $stPill.Margin = New-Object System.Windows.Thickness(0, 0, 5, 0)
        $stTxt = New-Object System.Windows.Controls.TextBlock
        $stTxt.Text = $t.statusLabel
        $stTxt.Foreground = New-Brush $stTheme.border
        $stTxt.FontSize = 9.5; $stTxt.FontWeight = 'Bold'
        $stPill.Child = $stTxt
        $leftTags.Children.Add($stPill) | Out-Null

        $provPill = New-Object System.Windows.Controls.Border
        $provPill.Background = New-Brush '#1E293B'
        $provPill.CornerRadius = New-Object System.Windows.CornerRadius(6)
        $provPill.Padding = New-Object System.Windows.Thickness(5, 1, 5, 1)
        $provPill.Margin = New-Object System.Windows.Thickness(0, 0, 5, 0)
        $provTxt = New-Object System.Windows.Controls.TextBlock
        $provTxt.Text = if ($t.isSubagent) { "$($t.providerName) · 서브" } else { $t.providerName }
        $provTxt.Foreground = New-Brush $t.providerColor
        $provTxt.FontSize = 9.5; $provTxt.FontWeight = 'SemiBold'
        $provPill.Child = $provTxt
        $leftTags.Children.Add($provPill) | Out-Null

        $topRow.Children.Add($leftTags) | Out-Null

        $relTxt = New-Object System.Windows.Controls.TextBlock
        $relTxt.Text = $t.updatedRel
        $relTxt.Foreground = New-Brush '#64748B'
        $relTxt.FontSize = 9.5
        $relTxt.HorizontalAlignment = 'Right'; $relTxt.VerticalAlignment = 'Center'
        $topRow.Children.Add($relTxt) | Out-Null
        $tsp.Children.Add($topRow) | Out-Null

        # Title
        $titleTxt = New-Object System.Windows.Controls.TextBlock
        $titleTxt.Text = $t.title
        $titleTxt.Foreground = New-Brush '#F8FAFC'
        $titleTxt.FontSize = 12; $titleTxt.FontWeight = 'SemiBold'
        $titleTxt.Margin = New-Object System.Windows.Thickness(0, 4, 0, 2)
        $titleTxt.TextTrimming = 'CharacterEllipsis'
        $tsp.Children.Add($titleTxt) | Out-Null

        # Status detail + model
        $metaTxt = New-Object System.Windows.Controls.TextBlock
        $cwdPart = if ($t.cwd) { " · $($t.cwd)" } else { '' }
        $metaTxt.Text = "$($t.statusDetail) · $($t.model)$cwdPart"
        $metaTxt.Foreground = New-Brush '#94A3B8'
        $metaTxt.FontSize = 10
        $metaTxt.TextTrimming = 'CharacterEllipsis'
        $tsp.Children.Add($metaTxt) | Out-Null

        # Current work summary
        $sumTxt = New-Object System.Windows.Controls.TextBlock
        $sumTxt.Text = $t.summary
        $sumTxt.Foreground = New-Brush '#CBD5E1'
        $sumTxt.FontSize = 10.5
        $sumTxt.Margin = New-Object System.Windows.Thickness(0, 3, 0, 0)
        $sumTxt.TextWrapping = 'Wrap'
        $sumTxt.MaxHeight = 32
        $sumTxt.TextTrimming = 'CharacterEllipsis'
        $tsp.Children.Add($sumTxt) | Out-Null

        $tCard.Child = $tsp
        $elTasksPanel.Children.Add($tCard) | Out-Null
    }
}

function Apply-Snapshot($snap) {
    if (-not $snap) { return }
    $script:LatestSnapshot = $snap
    Apply-PetVisualState $snap.overallState
    Update-TrayState $snap.overallState $snap.petSpeech

    $elCompactStateText.Text = $snap.compactStateText
    $elCompactQuotaText.Text = if ($snap.compactQuotaText) { $snap.compactQuotaText } else { '로컬 잔여량 확인 중' }
    $elCompactView.ToolTip = "$($snap.petSpeech)`n(클릭: 대시보드 열기 · 드래그: 이동 · 우클릭: 메뉴)"

    # Alert handling (seed existing errors on startup, toast only on NEW alerts)
    if ($snap.alerts) {
        if ($script:IsFirstSnapshot) {
            foreach ($a in $snap.alerts) {
                if ($a.severity -eq 'error') {
                    [void]$script:SeenAlerts.Add($a.alertKey)
                } elseif ($a.severity -eq 'approval') {
                    [void]$script:SeenAlerts.Add($a.alertKey)
                    if (-not $script:IsMuted -and -not $SmokeTest) {
                        $script:NotifyIcon.ShowBalloonTip(5000, "AI 승인 대기 ($($a.providerName))", $a.message, [System.Windows.Forms.ToolTipIcon]::Warning)
                    }
                }
            }
        } else {
            foreach ($a in $snap.alerts) {
                if (-not $script:SeenAlerts.Contains($a.alertKey)) {
                    [void]$script:SeenAlerts.Add($a.alertKey)
                    if (-not $script:IsMuted -and -not $SmokeTest) {
                        $tipTitle = if ($a.severity -eq 'approval') { "AI 승인 대기 ($($a.providerName))" } else { "AI 작업 오류 ($($a.providerName))" }
                        $tipIcon = if ($a.severity -eq 'approval') { [System.Windows.Forms.ToolTipIcon]::Warning } else { [System.Windows.Forms.ToolTipIcon]::Error }
                        $script:NotifyIcon.ShowBalloonTip(6000, $tipTitle, $a.message, $tipIcon)
                    }
                }
            }
        }
    }
    $script:IsFirstSnapshot = $false

    if ($script:IsExpanded) {
        Render-Dashboard
    }
}

# Background Runspace collector (keeps UI smooth)
$script:PollScript = {
    param($NodeExe, $CollectorPath)
    $procs = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        $_.Name -match '^(codex|ChatGPT|claude|cowork-svc|Antigravity|agy|language_server|cursor|ollama|lm-studio|windsurf|gemini|aider|opencode)\.exe$'
    }
    $summary = @{
        codexAppCount = 0; codexAppServerPids = @(); codexExecServerPids = @(); codexCliOtherPids = @();
        claudeDesktopCount = 0; claudeCliPids = @(); coworkSvcPids = @();
        antigravityCount = 0; agyCliPids = @(); languageServerCount = 0;
        otherAiProcs = @()
    }
    foreach ($p in $procs) {
        $cmd = [string]$p.CommandLine
        if ($p.Name -eq 'ChatGPT.exe' -and $cmd -match 'OpenAI\.Codex') { $summary.codexAppCount++ }
        elseif ($p.Name -eq 'codex.exe') {
            if ($cmd -match '\bapp-server\b') { $summary.codexAppServerPids += [int]$p.ProcessId }
            elseif ($cmd -match '\bexec-server\b') { $summary.codexExecServerPids += [int]$p.ProcessId }
            else { $summary.codexCliOtherPids += [int]$p.ProcessId }
        } elseif ($p.Name -eq 'claude.exe') {
            if ($cmd -match 'WindowsApps\\AnthropicPBC\.Claude|AnthropicClaude\\app-|--user-data-dir=|--type=') { $summary.claudeDesktopCount++ }
            else { $summary.claudeCliPids += [int]$p.ProcessId }
        } elseif ($p.Name -eq 'cowork-svc.exe') { $summary.coworkSvcPids += [int]$p.ProcessId }
        elseif ($p.Name -eq 'Antigravity.exe') { $summary.antigravityCount++ }
        elseif ($p.Name -eq 'agy.exe') { $summary.agyCliPids += [int]$p.ProcessId }
        elseif ($p.Name -eq 'language_server.exe') { $summary.languageServerCount++ }
        else { $summary.otherAiProcs += @{ name = $p.Name; pid = [int]$p.ProcessId } }
    }

    $procJson = $summary | ConvertTo-Json -Compress -Depth 4
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $NodeExe
    $psi.Arguments = "`"$CollectorPath`""
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.StandardOutputEncoding = [System.Text.UTF8Encoding]::new($false)
    $psi.EnvironmentVariables['AI_PROC_JSON'] = $procJson

    $proc = [System.Diagnostics.Process]::Start($psi)
    $stdout = $proc.StandardOutput.ReadToEnd()
    $proc.WaitForExit(8000) | Out-Null
    return $stdout
}

$script:Runspace = [runspacefactory]::CreateRunspace()
$script:Runspace.Open()
$script:ActiveJob = $null

function Start-BackgroundPoll {
    if ($null -ne $script:ActiveJob) { return }
    $ps = [powershell]::Create()
    $ps.Runspace = $script:Runspace
    [void]$ps.AddScript($script:PollScript).AddArgument($script:NodeExe).AddArgument($script:CollectorPath)
    $async = $ps.BeginInvoke()
    $script:ActiveJob = @{ ps = $ps; async = $async }
}

function Try-FinishBackgroundPoll {
    if ($null -eq $script:ActiveJob) { return }
    if (-not $script:ActiveJob.async.IsCompleted) { return }
    $ps = $script:ActiveJob.ps
    $async = $script:ActiveJob.async
    $script:ActiveJob = $null
    try {
        $out = $ps.EndInvoke($async)
        $jsonLine = ($out | Out-String).Trim()
        if ($jsonLine) {
            $snap = $jsonLine | ConvertFrom-Json
            Apply-Snapshot $snap
        }
    } catch {
        # Keep previous snapshot if transient read error occurred
    } finally {
        $ps.Dispose()
    }
}

# Drag & Click interaction for Compact Pet
$script:DragStartMouse = $null
$script:DragStartWin = $null
$script:IsDragging = $false

$elCompactView.Add_MouseLeftButtonDown({
    param($s, $e)
    $script:DragStartMouse = $script:Window.PointToScreen($e.GetPosition($script:Window))
    $script:DragStartWin = New-Object System.Windows.Point($script:Window.Left, $script:Window.Top)
    $script:IsDragging = $false
    $elCompactView.CaptureMouse() | Out-Null
})

$elCompactView.Add_MouseMove({
    param($s, $e)
    if (-not $elCompactView.IsMouseCaptured) { return }
    $cur = $script:Window.PointToScreen($e.GetPosition($script:Window))
    $dx = $cur.X - $script:DragStartMouse.X
    $dy = $cur.Y - $script:DragStartMouse.Y
    if (-not $script:IsDragging -and ([Math]::Abs($dx) -ge 5 -or [Math]::Abs($dy) -ge 5)) {
        $script:IsDragging = $true
    }
    if ($script:IsDragging) {
        $c = Clamp-Position ($script:DragStartWin.X + $dx) ($script:DragStartWin.Y + $dy) 330 82
        $script:Window.Left = $c[0]
        $script:Window.Top = $c[1]
        $script:PetLeft = $c[0]
        $script:PetTop = $c[1]
    }
})

$elCompactView.Add_MouseLeftButtonUp({
    param($s, $e)
    if ($elCompactView.IsMouseCaptured) { $elCompactView.ReleaseMouseCapture() }
    if ($script:IsDragging) {
        Save-WidgetState
    } else {
        Set-ExpandedMode $true
    }
    $script:IsDragging = $false
})

# Header drag for Expanded Dashboard
$elExpandedHeader.Add_MouseLeftButtonDown({
    param($s, $e)
    if ($e.OriginalSource -is [System.Windows.Controls.Button]) { return }
    try { $script:Window.DragMove() } catch {}
})

# Buttons & Tabs
$elBtnRefresh.Add_Click({ Start-BackgroundPoll })
$elBtnCollapse.Add_Click({ Set-ExpandedMode $false })
$elBtnTopmost.Add_Click({
    $script:IsTopmost = -not $script:IsTopmost
    Update-HeaderToggles
    Save-WidgetState
})
$elBtnMute.Add_Click({
    $script:IsMuted = -not $script:IsMuted
    Update-HeaderToggles
    Save-WidgetState
})
$elBtnExternalDir.Add_Click({
    if (-not (Test-Path -LiteralPath $script:ExternalDir)) {
        New-Item -ItemType Directory -Path $script:ExternalDir -Force | Out-Null
    }
    $readme = Join-Path $script:ExternalDir '_README_EXAMPLE.txt'
    if (-not (Test-Path -LiteralPath $readme)) {
        $sample = @"
이 폴더에 *.json 파일을 놓으면 AI Desk Pet 위젯에 즉시 함께 표시됩니다.
예시 파일명: my-agent.json

{
  "provider": "gemini-cli",
  "providerName": "Gemini CLI",
  "shortName": "Gem",
  "color": "#3B82F6",
  "title": "문서 요약 배치 작업",
  "status": "running",
  "statusDetail": "작업 중",
  "summary": "PDF 12건 텍스트 추출 중",
  "remainingPct": 72,
  "quotaLabel": "일일 잔여",
  "model": "gemini-4-flash"
}

status 값: running | approval | paused | error | done
"@
        [System.IO.File]::WriteAllText($readme, $sample, [System.Text.UTF8Encoding]::new($false))
    }
    Start-Process explorer.exe "`"$script:ExternalDir`""
})
$elBtnQuit.Add_Click({ $script:Window.Close() })

$elTabAll.Add_Click({ $script:ActiveFilter = 'all'; Render-Dashboard })
$elTabActive.Add_Click({ $script:ActiveFilter = 'active'; Render-Dashboard })
$elTabAlert.Add_Click({ $script:ActiveFilter = 'alert'; Render-Dashboard })
$elTabDone.Add_Click({ $script:ActiveFilter = 'done'; Render-Dashboard })

# Context Menu (Tray + Right Click)
$ctxMenu = New-Object System.Windows.Forms.ContextMenuStrip
$miToggle = $ctxMenu.Items.Add('대시보드 펼치기 / 접기')
$miRefresh = $ctxMenu.Items.Add('지금 새로고침')
$ctxMenu.Items.Add('-') | Out-Null
$miTopmost = $ctxMenu.Items.Add('항상 위(Topmost) 전환')
$miMute = $ctxMenu.Items.Add('알림 토스트 끄기/켜기')
$miResetPos = $ctxMenu.Items.Add('기본 위치로 초기화')
$ctxMenu.Items.Add('-') | Out-Null
$miQuit = $ctxMenu.Items.Add('종료')

$miToggle.Add_Click({ Set-ExpandedMode (-not $script:IsExpanded) })
$miRefresh.Add_Click({ Start-BackgroundPoll })
$miTopmost.Add_Click({ $script:IsTopmost = -not $script:IsTopmost; Update-HeaderToggles; Save-WidgetState })
$miMute.Add_Click({ $script:IsMuted = -not $script:IsMuted; Update-HeaderToggles; Save-WidgetState })
$miResetPos.Add_Click({
    $waNow = [System.Windows.SystemParameters]::WorkArea
    $script:PetLeft = $waNow.Right - 300
    $script:PetTop = $waNow.Bottom - 110
    if ($script:IsExpanded) { Set-ExpandedMode $false }
    $script:Window.Left = $script:PetLeft
    $script:Window.Top = $script:PetTop
    Save-WidgetState
})
$miQuit.Add_Click({ $script:Window.Close() })

$script:NotifyIcon.ContextMenuStrip = $ctxMenu
$script:NotifyIcon.Add_MouseClick({
    param($s, $e)
    if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) {
        $script:Window.Dispatcher.BeginInvoke([Action]{
            Set-ExpandedMode (-not $script:IsExpanded)
            $script:Window.Activate() | Out-Null
        }) | Out-Null
    }
})

$elCompactView.Add_MouseRightButtonUp({
    param($s, $e)
    $ctxMenu.Show([System.Windows.Forms.Cursor]::Position)
    $e.Handled = $true
})

# Timers
$script:AnimTimer = New-Object System.Windows.Threading.DispatcherTimer
$script:AnimTimer.Interval = [TimeSpan]::FromMilliseconds(60)
$script:AnimTimer.Add_Tick({
    $script:AnimTick++
    Try-FinishBackgroundPoll

    $t = $script:AnimTick
    switch ($script:CurrentState) {
        'approval' {
            $elPetTranslate.Y = -4.0 * [Math]::Abs([Math]::Sin($t * 0.35))
            $elPetTranslate.X = 1.8 * [Math]::Sin($t * 0.7)
            $elPetRotate.Angle = 3.5 * [Math]::Sin($t * 0.45)
            $elPetHalo.Opacity = 0.45 + 0.55 * [Math]::Abs([Math]::Sin($t * 0.25))
        }
        'error' {
            $elPetTranslate.X = 2.8 * [Math]::Sin($t * 1.1)
            $elPetTranslate.Y = 0
            $elPetRotate.Angle = 4.0 * [Math]::Sin($t * 0.9)
            $elPetHalo.Opacity = 0.4 + 0.6 * [Math]::Abs([Math]::Sin($t * 0.35))
        }
        'running' {
            $elPetTranslate.X = 0
            $elPetTranslate.Y = -3.2 * [Math]::Abs([Math]::Sin($t * 0.22))
            $elPetRotate.Angle = 2.0 * [Math]::Sin($t * 0.22)
            $elPetHalo.Opacity = 0.55 + 0.35 * [Math]::Sin($t * 0.2)
        }
        'paused' {
            $elPetTranslate.X = 0
            $elPetTranslate.Y = 1.2 * [Math]::Sin($t * 0.08)
            $elPetRotate.Angle = -4.0
            $elPetHalo.Opacity = 0.45
        }
        'done' {
            $elPetTranslate.X = 0
            $elPetTranslate.Y = -3.5 * [Math]::Abs([Math]::Sin($t * 0.2))
            $elPetRotate.Angle = 0
            $elPetHalo.Opacity = 0.65
        }
        default {
            $elPetTranslate.X = 0
            $elPetTranslate.Y = 1.8 * [Math]::Sin($t * 0.09)
            $elPetRotate.Angle = 0
            $elPetHalo.Opacity = 0.35
        }
    }
})

$script:PollTimer = New-Object System.Windows.Threading.DispatcherTimer
$script:PollTimer.Interval = [TimeSpan]::FromSeconds([Math]::Max(2, $IntervalSeconds))
$script:PollTimer.Add_Tick({ Start-BackgroundPoll })

$script:Window.Add_Closed({
    try { $script:AnimTimer.Stop() } catch {}
    try { $script:PollTimer.Stop() } catch {}
    try {
        if ($script:NotifyIcon) {
            $script:NotifyIcon.Visible = $false
            $script:NotifyIcon.Dispose()
        }
    } catch {}
    try { if ($script:TrayIconHandle) { $script:TrayIconHandle.Dispose() } } catch {}
    try { if ($script:Runspace) { $script:Runspace.Close(); $script:Runspace.Dispose() } } catch {}
    try {
        if ($script:Mutex) {
            $script:Mutex.ReleaseMutex()
            $script:Mutex.Dispose()
        }
    } catch {}
})

if ($SmokeTest) {
    $script:Window.Show()
    # Run one synchronous poll via PollScript to verify full data pipeline + UI rendering
    $raw = & $script:PollScript $script:NodeExe $script:CollectorPath
    $snap = ($raw | Out-String).Trim() | ConvertFrom-Json
    Apply-Snapshot $snap
    foreach ($st in @('idle', 'running', 'approval', 'paused', 'error', 'done')) {
        Apply-PetVisualState $st
    }
    Set-ExpandedMode $true
    $provCount = $elProvidersPanel.Children.Count
    $taskCount = $elTasksPanel.Children.Count
    Set-ExpandedMode $false
    $script:Window.Close()
    Write-Output "SMOKE_TEST_OK providers=$provCount tasks=$taskCount overall=$($snap.overallState)"
    return
}

$script:AnimTimer.Start()
$script:PollTimer.Start()
Start-BackgroundPoll
[void]$script:Window.ShowDialog()
