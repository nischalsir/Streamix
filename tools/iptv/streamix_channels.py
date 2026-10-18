"""Build the Streamix Hindi, English and Sports Live TV channel list for a Jellyfin server.

Downloads the public iptv-org playlists, checks each candidate stream from this network the way the
Streamix player fetches it (HLS only, no http<->https redirects, 8 s timeouts), and writes a numbered M3U
of the ones that play: Hindi 201+, English 301+, Sports 501+.

Only channels that are free to watch are listed: public broadcasters, official free news streams,
free-to-air movie and music channels, and ad-supported streaming channels (Pluto TV, Stingray, FIFA+...).
Pay-TV channels that turn up in public lists (Star Sports, Sony Ten, ESPN, beIN 1-8, Willow, unofficial
"sports apps" and their restreams) are left out on purpose.

    python streamix_channels.py --out "C:/ProgramData/Jellyfin/Server/iptv/streamix-hindi-english.m3u"

Then in Jellyfin: Dashboard > Live TV > Tuner devices > + > M3U Tuner with that file (once), and
Dashboard > Scheduled tasks > Refresh Guide after every rebuild. Free streams come and go, so rebuilding
every month or so keeps the list working.
"""
import argparse
import concurrent.futures as cf
import re
import ssl
import urllib.error
import urllib.parse
import urllib.request

PLAYLISTS = {
    'Hindi': 'https://iptv-org.github.io/iptv/languages/hin.m3u',
    'English': 'https://iptv-org.github.io/iptv/languages/eng.m3u',
    'Sports': 'https://iptv-org.github.io/iptv/categories/sports.m3u',
}
UA = 'Streamix (Linux;Android 11) AndroidXMedia3/1.11.1'
TIMEOUT = 8
TAG = re.compile(r'\s*[\(\[][^\)\]]*[\)\]]')

HINDI = {
    'Entertainment': ['DD National HD', 'DD National', 'Dangal TV', 'Dangal 2', 'Shemaroo TV', 'Shemaroo Umang',
                      'Manoranjan TV', 'E 24'],
    'Movies': ['B4U Movies', 'B4U Kadak', 'Goldmines', 'Goldmines 2', 'Goldmines Action', 'Goldmines Bollywood',
               'Shemaroo Josh', 'Manoranjan Grand', 'Shubh Cinema TV', 'Maha Movie', 'MH One Movies', 'NH BollyFlix',
               'Bollygold', 'The Movie Club', 'Pocket Films'],
    'Music': ['B4U Music', 'Music India', 'Mastiii', 'Dhamaal', 'Deewana HD', 'Boogle Bollywood', 'NH BollyRaga',
              'Songdew TV', 'Balle Balle HD', 'Balle Balle'],
    'Kids': ['WOW Kidz'],
    'News': ['Aaj Tak HD', 'ABP News', 'India TV', 'NDTV India', 'News18 India', 'Zee News', 'Times Now Navbharat HD',
             'Times Now Navbharat', 'TV9 Bharatvarsh', 'News Nation', 'DD News HD', 'DD News', 'Good News Today',
             'India Daily Live', 'Bharat24', 'News 1 India', 'Zee Bharat', 'Bharat Samachar', 'India TV Speed News',
             'Zee Business', 'CNBC Awaaz'],
    'More': ['DD Bharati', 'DD Kisan', 'Food Food'],
}

ENGLISH = {
    'News': ['Al Jazeera English', 'DW English', 'France 24 English', 'Euronews English HD', 'Euronews English', 'CGTN',
             'NHK World-Japan HD', 'NHK World-Japan', 'TRT World HD', 'TRT World', 'CNA International',
             'Africanews English', 'ABC News Live', 'CBS News 24/7', 'NBC News NOW', 'LiveNOW from FOX', 'Scripps News',
             'Reuters TV', 'Cheddar News', 'TODAY All Day', 'USA TODAY', 'UN Web TV', 'ABC News',
             'WION', 'India Today', 'NDTV 24x7', 'CNN News 18', 'NewsX World', 'DD India', 'TOI Global', 'News9Live',
             'NDTV Profit', 'India Ahead', 'Bloomberg Originals'],
    'Documentary': ['Documentary+', 'Love Nature HD', 'Love Nature', 'WildEarth', 'History Hit', 'Wonder',
                    'CGTN Documentary', 'CNA Originals', 'Terra Mater WILD English', 'Pluto TV History',
                    'Pluto TV Science', 'Get.factual', 'Dateline 24/7'],
    'Kids': ['PBS Kids', 'ABC Kids', 'TVOKids', 'Moonbug Kids', 'Baby Shark TV', 'Peppa Pig', 'Super Simple Songs',
             'Ryan and Friends', 'HappyKids', 'Kartoon Channel!', 'Teletubbies', 'Dora TV', 'SpongeBob SquarePants',
             'Nick Jr. Pluto TV', 'Nickelodeon Pluto TV', 'Smurf TV', 'Garfield and Friends', 'Kids Movie Club',
             'LEGO Kids TV'],
    'Anime & animation': ['Pluto TV Anime', 'Anime x HIDIVE', 'RetroCrush', 'Sonic TV', 'Yu-Gi-Oh!'],
    'Movies': ['Pluto TV Action', 'Pluto TV Comedy Movies', 'Pluto TV Drama Movies', 'Pluto TV Horror',
               'Pluto TV Romance', 'Pluto TV Thrillers', 'Pluto TV Westerns', 'Pluto TV Family Movie Club',
               'Pluto TV Staff Picks', 'Pluto TV Trending Now', 'MovieSphere', 'Runtime', '24 Hour Free Movies',
               'Gravitas Movies', 'Paramount Movie Channel', 'Made In Hollywood', 'Classic Movies Channel'],
    'Series': ['Star Trek: The Next Generation', 'Pluto TV Classic TV', 'The Graham Norton Show',
               'Pluto TV Investigation', 'Pluto TV Crime Drama'],
    'Music': ['Stingray Hit List', "Stingray Nothin' But 90s", "Stingray Everything '80s", 'Stingray Classic Rock',
              'Stingray Smooth Jazz', "Stingray Today's K-Pop", 'Stingray Naturescape', 'Stingray Hot Country',
              'Qello Concerts by Stingray', 'NOW Rock', 'Now 90s00s', "That's 80s"],
    'Lifestyle': ['Gusto TV', 'Pluto TV Food GB', 'Love Pets', 'Horse & Country TV'],
}


# Free, official sports channels (broadcasters' own free streams and ad-supported channels)
SPORTS = {
    'India & cricket': ['DD Sports', 'Cricket Gold'],
    'Football': ['FIFA+', 'Golazo Network', 'beIN SPORTS XTRA', 'Real Madrid TV English'],
    'Sports news': ['CBS Sports HQ', 'NBC Sports NOW', 'SportsGrid', 'Stadium'],
    'US sports': ['NFL Channel', 'MLB', 'ACC Digital Network', 'Pac-12 Insider'],
    'Tennis & golf': ['Tennis Channel 2', 'PGA Tour'],
    'Action & motorsport': ['Red Bull TV', 'Rally TV', 'Monster Jam', 'Strongman Champions League'],
    'Fighting': ['Bellator MMA', 'PFL MMA', 'FITE 24/7', 'DAZN Combat', 'TVS Boxing', 'Swerve Combat'],
    'More': ['World Poker Tour', 'Unbeaten', 'Swerve Sports', 'Pluto TV Competition', 'TVS Classic Sports',
             'Trace Sport Stars', 'talkSPORT'],
}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


OPENER = urllib.request.build_opener(NoRedirect, urllib.request.HTTPSHandler(context=ssl.create_default_context()))


def fetch(url, limit=2_000_000):
    """GET following same-protocol redirects only (ExoPlayer's default). Returns (final_url, bytes)."""
    for _ in range(6):
        req = urllib.request.Request(url, headers={'User-Agent': UA})
        try:
            resp = OPENER.open(req, timeout=TIMEOUT)
        except urllib.error.HTTPError as e:
            if e.code in (301, 302, 303, 307, 308):
                loc = urllib.parse.urljoin(url, e.headers.get('Location', ''))
                if urllib.parse.urlsplit(loc).scheme != urllib.parse.urlsplit(url).scheme:
                    raise RuntimeError('cross-protocol redirect') from None
                url = loc
                continue
            raise RuntimeError(f'http {e.code}') from None
        with resp:
            return url, resp.read(limit)
    raise RuntimeError('too many redirects')


def parse(text):
    entries = []
    attrs, name, opts = None, None, []
    for line in text.splitlines():
        line = line.strip()
        if line.startswith('#EXTINF'):
            # The name follows the last attribute; attribute values can contain commas
            m = re.match(r'#EXTINF:[^,"]*(?:"[^"]*"[^,"]*)*,(.*)$', line)
            name = m.group(1) if m else line.rsplit(',', 1)[-1]
            attrs = dict(re.findall(r'([\w-]+)="([^"]*)"', line))
            opts = []
        elif line.startswith('#EXTVLCOPT') or line.startswith('#KODIPROP'):
            opts.append(line)
        elif line and not line.startswith('#') and attrs is not None:
            entries.append({'name': name.strip(), 'id': attrs.get('tvg-id', ''), 'logo': attrs.get('tvg-logo', ''),
                            'url': line, 'opts': opts})
            attrs = None
    return entries


def check(entry):
    """True if the playlist, its lowest-quality variant and a recent segment all load."""
    try:
        if entry['opts']:
            return False, 0  # needs custom headers the player doesn't send
        final, body = fetch(entry['url'])
        text = body.decode('utf-8', 'replace')
        if not text.lstrip().startswith('#EXTM3U'):
            return False, 0
        height = 0
        if '#EXT-X-STREAM-INF' in text:
            variants = []
            lines = text.splitlines()
            for i, line in enumerate(lines):
                if line.startswith('#EXT-X-STREAM-INF'):
                    m = re.search(r'RESOLUTION=\d+x(\d+)', line)
                    for nxt in lines[i + 1:]:
                        if nxt and not nxt.startswith('#'):
                            variants.append((int(m.group(1)) if m else 0, urllib.parse.urljoin(final, nxt.strip())))
                            break
            if not variants:
                return False, 0
            variants.sort()
            height = variants[-1][0]
            final, body = fetch(variants[0][1])
            text = body.decode('utf-8', 'replace')
        segments = [s.strip() for s in text.splitlines() if s.strip() and not s.startswith('#')]
        if not segments:
            return False, height
        _, data = fetch(urllib.parse.urljoin(final, segments[-1]), limit=65536)
        return len(data) >= 1024, height
    except Exception:  # noqa: BLE001 - anything at all means it won't play
        return False, 0


def clean(name):
    return TAG.sub('', name).strip() or name


def base(name):
    """The same channel in HD and SD shares a base name."""
    return re.sub(r'\s+(hd|sd)$', '', clean(name).lower())


def main():
    parser = argparse.ArgumentParser(description='Build the Streamix Hindi, English and Sports channel list.')
    parser.add_argument('--out', default='streamix-hindi-english.m3u', help='where to write the M3U')
    args = parser.parse_args()

    lists = {'Hindi': HINDI, 'English': ENGLISH, 'Sports': SPORTS}
    candidates = []
    for lang, url in PLAYLISTS.items():
        wanted = {n for names in lists[lang].values() for n in names}
        _, data = fetch(url, limit=50_000_000)
        for e in parse(data.decode('utf-8', 'replace')):
            if clean(e['name']) in wanted:
                e['lang'] = lang
                candidates.append(e)
    print(f'checking {len(candidates)} streams...', flush=True)
    with cf.ThreadPoolExecutor(max_workers=32) as pool:
        results = list(pool.map(check, candidates))

    working = {}
    for e, (ok, height) in zip(candidates, results):
        key = (e['lang'], clean(e['name']))
        if ok and (key not in working or height > working[key][1]):
            working[key] = (e, height)

    lines = ['#EXTM3U']
    for lang, start in (('Hindi', 201), ('English', 301), ('Sports', 501)):
        number, taken = start, set()
        for group, names in lists[lang].items():
            for name in names:
                found = working.get((lang, name))
                if found is None or base(name) in taken:
                    continue
                e = found[0]
                taken.add(base(name))
                display = name[:-3] if name.endswith(' HD') else name
                lines.append(f'#EXTINF:-1 tvg-id="{e["id"]}" tvg-chno="{number}" tvg-logo="{e["logo"]}" '
                             f'group-title="{lang} · {group}",{display}')
                lines.append(e['url'])
                number += 1
        print(f'{lang}: {number - start} channels ({start}-{number - 1})')
    with open(args.out, 'w', encoding='utf-8', newline='\n') as f:
        f.write('\n'.join(lines) + '\n')
    print('wrote', args.out)


if __name__ == '__main__':
    main()
