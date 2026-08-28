/**
 * The real world, at city granularity (spec 80).
 *
 * Coordinates are actual city centres, so parcels land on real streets under
 * the OpenStreetMap basemap the client renders. Populations are city proper —
 * not metropolitan area — rounded to the nearest ten thousand; they feed land
 * valuation, so precision beyond that buys nothing.
 *
 * `baseRatePerSqm` is a game-balance figure, not a real property price. It is
 * kept within roughly 0.35–1.60 so the cheapest lots stay reachable on a
 * starting balance while prime cities remain something to save for. Real land
 * prices span four orders of magnitude and would leave most of the map either
 * free or permanently unbuyable.
 *
 * This is a starting set, not a claim to completeness: it spans six continents
 * so no player is forced onto another hemisphere's clock. Adding a city means
 * appending an entry here and re-seeding.
 */

export interface CitySeed {
  name: string;
  lat: number;
  lng: number;
  population: number;
  baseRatePerSqm: number;
}

export interface RegionSeed {
  name: string;
  /** ISO 3166-2 subdivision code. */
  code: string;
  cities: CitySeed[];
}

export interface CountrySeed {
  name: string;
  /** ISO 3166-1 alpha-3. */
  code: string;
  regions: RegionSeed[];
}

export const WORLD: CountrySeed[] = [
  {
    name: 'United States',
    code: 'USA',
    regions: [
      {
        name: 'New York',
        code: 'US-NY',
        cities: [
          {
            name: 'New York',
            lat: 40.7128,
            lng: -74.006,
            population: 8_260_000,
            baseRatePerSqm: 1.6,
          },
          {
            name: 'Buffalo',
            lat: 42.8864,
            lng: -78.8784,
            population: 280_000,
            baseRatePerSqm: 0.42,
          },
        ],
      },
      {
        name: 'California',
        code: 'US-CA',
        cities: [
          {
            name: 'Los Angeles',
            lat: 34.0522,
            lng: -118.2437,
            population: 3_820_000,
            baseRatePerSqm: 1.32,
          },
          {
            name: 'San Francisco',
            lat: 37.7749,
            lng: -122.4194,
            population: 810_000,
            baseRatePerSqm: 1.5,
          },
        ],
      },
      {
        name: 'Illinois',
        code: 'US-IL',
        cities: [
          {
            name: 'Chicago',
            lat: 41.8781,
            lng: -87.6298,
            population: 2_660_000,
            baseRatePerSqm: 0.95,
          },
        ],
      },
      {
        name: 'Texas',
        code: 'US-TX',
        cities: [
          {
            name: 'Houston',
            lat: 29.7604,
            lng: -95.3698,
            population: 2_310_000,
            baseRatePerSqm: 0.68,
          },
          {
            name: 'Austin',
            lat: 30.2672,
            lng: -97.7431,
            population: 980_000,
            baseRatePerSqm: 0.79,
          },
        ],
      },
    ],
  },
  {
    name: 'Canada',
    code: 'CAN',
    regions: [
      {
        name: 'Ontario',
        code: 'CA-ON',
        cities: [
          {
            name: 'Toronto',
            lat: 43.6532,
            lng: -79.3832,
            population: 2_790_000,
            baseRatePerSqm: 1.18,
          },
          {
            name: 'Ottawa',
            lat: 45.4215,
            lng: -75.6972,
            population: 1_020_000,
            baseRatePerSqm: 0.66,
          },
        ],
      },
      {
        name: 'British Columbia',
        code: 'CA-BC',
        cities: [
          {
            name: 'Vancouver',
            lat: 49.2827,
            lng: -123.1207,
            population: 660_000,
            baseRatePerSqm: 1.28,
          },
        ],
      },
      {
        name: 'Quebec',
        code: 'CA-QC',
        cities: [
          {
            name: 'Montreal',
            lat: 45.5019,
            lng: -73.5674,
            population: 1_760_000,
            baseRatePerSqm: 0.74,
          },
        ],
      },
    ],
  },
  {
    name: 'Mexico',
    code: 'MEX',
    regions: [
      {
        name: 'Mexico City',
        code: 'MX-CMX',
        cities: [
          {
            name: 'Mexico City',
            lat: 19.4326,
            lng: -99.1332,
            population: 9_210_000,
            baseRatePerSqm: 0.72,
          },
        ],
      },
      {
        name: 'Jalisco',
        code: 'MX-JAL',
        cities: [
          {
            name: 'Guadalajara',
            lat: 20.6597,
            lng: -103.3496,
            population: 1_390_000,
            baseRatePerSqm: 0.48,
          },
        ],
      },
    ],
  },
  {
    name: 'Brazil',
    code: 'BRA',
    regions: [
      {
        name: 'Sao Paulo',
        code: 'BR-SP',
        cities: [
          {
            name: 'Sao Paulo',
            lat: -23.5505,
            lng: -46.6333,
            population: 11_450_000,
            baseRatePerSqm: 0.86,
          },
        ],
      },
      {
        name: 'Rio de Janeiro',
        code: 'BR-RJ',
        cities: [
          {
            name: 'Rio de Janeiro',
            lat: -22.9068,
            lng: -43.1729,
            population: 6_210_000,
            baseRatePerSqm: 0.7,
          },
        ],
      },
    ],
  },
  {
    name: 'Argentina',
    code: 'ARG',
    regions: [
      {
        name: 'Buenos Aires',
        code: 'AR-C',
        cities: [
          {
            name: 'Buenos Aires',
            lat: -34.6037,
            lng: -58.3816,
            population: 3_120_000,
            baseRatePerSqm: 0.61,
          },
        ],
      },
    ],
  },
  {
    name: 'United Kingdom',
    code: 'GBR',
    regions: [
      {
        name: 'England',
        code: 'GB-ENG',
        cities: [
          {
            name: 'London',
            lat: 51.5072,
            lng: -0.1276,
            population: 8_900_000,
            baseRatePerSqm: 1.55,
          },
          {
            name: 'Manchester',
            lat: 53.4808,
            lng: -2.2426,
            population: 570_000,
            baseRatePerSqm: 0.69,
          },
        ],
      },
      {
        name: 'Scotland',
        code: 'GB-SCT',
        cities: [
          {
            name: 'Edinburgh',
            lat: 55.9533,
            lng: -3.1883,
            population: 530_000,
            baseRatePerSqm: 0.75,
          },
        ],
      },
    ],
  },
  {
    name: 'France',
    code: 'FRA',
    regions: [
      {
        name: 'Ile-de-France',
        code: 'FR-IDF',
        cities: [
          { name: 'Paris', lat: 48.8566, lng: 2.3522, population: 2_130_000, baseRatePerSqm: 1.45 },
        ],
      },
      {
        name: 'Provence-Alpes-Cote d Azur',
        code: 'FR-PAC',
        cities: [
          {
            name: 'Marseille',
            lat: 43.2965,
            lng: 5.3698,
            population: 870_000,
            baseRatePerSqm: 0.63,
          },
        ],
      },
    ],
  },
  {
    name: 'Germany',
    code: 'DEU',
    regions: [
      {
        name: 'Berlin',
        code: 'DE-BE',
        cities: [
          { name: 'Berlin', lat: 52.52, lng: 13.405, population: 3_760_000, baseRatePerSqm: 1.05 },
        ],
      },
      {
        name: 'Bavaria',
        code: 'DE-BY',
        cities: [
          {
            name: 'Munich',
            lat: 48.1351,
            lng: 11.582,
            population: 1_510_000,
            baseRatePerSqm: 1.24,
          },
        ],
      },
      {
        name: 'North Rhine-Westphalia',
        code: 'DE-NW',
        cities: [
          {
            name: 'Cologne',
            lat: 50.9375,
            lng: 6.9603,
            population: 1_080_000,
            baseRatePerSqm: 0.8,
          },
        ],
      },
    ],
  },
  {
    name: 'Spain',
    code: 'ESP',
    regions: [
      {
        name: 'Madrid',
        code: 'ES-MD',
        cities: [
          {
            name: 'Madrid',
            lat: 40.4168,
            lng: -3.7038,
            population: 3_280_000,
            baseRatePerSqm: 0.92,
          },
        ],
      },
      {
        name: 'Catalonia',
        code: 'ES-CT',
        cities: [
          {
            name: 'Barcelona',
            lat: 41.3874,
            lng: 2.1686,
            population: 1_620_000,
            baseRatePerSqm: 0.98,
          },
        ],
      },
    ],
  },
  {
    name: 'Italy',
    code: 'ITA',
    regions: [
      {
        name: 'Lazio',
        code: 'IT-62',
        cities: [
          { name: 'Rome', lat: 41.9028, lng: 12.4964, population: 2_760_000, baseRatePerSqm: 0.89 },
        ],
      },
      {
        name: 'Lombardy',
        code: 'IT-25',
        cities: [
          { name: 'Milan', lat: 45.4642, lng: 9.19, population: 1_370_000, baseRatePerSqm: 1.02 },
        ],
      },
    ],
  },
  {
    name: 'Poland',
    code: 'POL',
    regions: [
      {
        name: 'Masovia',
        code: 'PL-14',
        cities: [
          {
            name: 'Warsaw',
            lat: 52.2297,
            lng: 21.0122,
            population: 1_860_000,
            baseRatePerSqm: 0.66,
          },
        ],
      },
    ],
  },
  {
    name: 'Nigeria',
    code: 'NGA',
    regions: [
      {
        name: 'Lagos',
        code: 'NG-LA',
        cities: [
          { name: 'Lagos', lat: 6.5244, lng: 3.3792, population: 9_000_000, baseRatePerSqm: 0.58 },
        ],
      },
      {
        name: 'Federal Capital Territory',
        code: 'NG-FC',
        cities: [
          { name: 'Abuja', lat: 9.0765, lng: 7.3986, population: 1_240_000, baseRatePerSqm: 0.44 },
        ],
      },
    ],
  },
  {
    name: 'Egypt',
    code: 'EGY',
    regions: [
      {
        name: 'Cairo',
        code: 'EG-C',
        cities: [
          {
            name: 'Cairo',
            lat: 30.0444,
            lng: 31.2357,
            population: 9_540_000,
            baseRatePerSqm: 0.52,
          },
        ],
      },
    ],
  },
  {
    name: 'Kenya',
    code: 'KEN',
    regions: [
      {
        name: 'Nairobi',
        code: 'KE-30',
        cities: [
          {
            name: 'Nairobi',
            lat: -1.2864,
            lng: 36.8172,
            population: 4_400_000,
            baseRatePerSqm: 0.45,
          },
        ],
      },
    ],
  },
  {
    name: 'South Africa',
    code: 'ZAF',
    regions: [
      {
        name: 'Gauteng',
        code: 'ZA-GP',
        cities: [
          {
            name: 'Johannesburg',
            lat: -26.2041,
            lng: 28.0473,
            population: 5_640_000,
            baseRatePerSqm: 0.5,
          },
        ],
      },
      {
        name: 'Western Cape',
        code: 'ZA-WC',
        cities: [
          {
            name: 'Cape Town',
            lat: -33.9249,
            lng: 18.4241,
            population: 4_770_000,
            baseRatePerSqm: 0.64,
          },
        ],
      },
    ],
  },
  {
    name: 'India',
    code: 'IND',
    regions: [
      {
        name: 'Maharashtra',
        code: 'IN-MH',
        cities: [
          {
            name: 'Mumbai',
            lat: 19.076,
            lng: 72.8777,
            population: 12_440_000,
            baseRatePerSqm: 0.96,
          },
        ],
      },
      {
        name: 'Delhi',
        code: 'IN-DL',
        cities: [
          {
            name: 'New Delhi',
            lat: 28.6139,
            lng: 77.209,
            population: 11_030_000,
            baseRatePerSqm: 0.78,
          },
        ],
      },
      {
        name: 'Karnataka',
        code: 'IN-KA',
        cities: [
          {
            name: 'Bengaluru',
            lat: 12.9716,
            lng: 77.5946,
            population: 8_440_000,
            baseRatePerSqm: 0.71,
          },
        ],
      },
    ],
  },
  {
    name: 'China',
    code: 'CHN',
    regions: [
      {
        name: 'Shanghai',
        code: 'CN-SH',
        cities: [
          {
            name: 'Shanghai',
            lat: 31.2304,
            lng: 121.4737,
            population: 24_870_000,
            baseRatePerSqm: 1.22,
          },
        ],
      },
      {
        name: 'Beijing',
        code: 'CN-BJ',
        cities: [
          {
            name: 'Beijing',
            lat: 39.9042,
            lng: 116.4074,
            population: 21_890_000,
            baseRatePerSqm: 1.16,
          },
        ],
      },
      {
        name: 'Guangdong',
        code: 'CN-GD',
        cities: [
          {
            name: 'Shenzhen',
            lat: 22.5431,
            lng: 114.0579,
            population: 17_560_000,
            baseRatePerSqm: 1.09,
          },
        ],
      },
    ],
  },
  {
    name: 'Japan',
    code: 'JPN',
    regions: [
      {
        name: 'Tokyo',
        code: 'JP-13',
        cities: [
          {
            name: 'Tokyo',
            lat: 35.6762,
            lng: 139.6503,
            population: 13_960_000,
            baseRatePerSqm: 1.42,
          },
        ],
      },
      {
        name: 'Osaka',
        code: 'JP-27',
        cities: [
          {
            name: 'Osaka',
            lat: 34.6937,
            lng: 135.5023,
            population: 2_750_000,
            baseRatePerSqm: 1.0,
          },
        ],
      },
    ],
  },
  {
    name: 'South Korea',
    code: 'KOR',
    regions: [
      {
        name: 'Seoul',
        code: 'KR-11',
        cities: [
          {
            name: 'Seoul',
            lat: 37.5665,
            lng: 126.978,
            population: 9_390_000,
            baseRatePerSqm: 1.26,
          },
        ],
      },
    ],
  },
  {
    name: 'Indonesia',
    code: 'IDN',
    regions: [
      {
        name: 'Jakarta',
        code: 'ID-JK',
        cities: [
          {
            name: 'Jakarta',
            lat: -6.2088,
            lng: 106.8456,
            population: 10_560_000,
            baseRatePerSqm: 0.6,
          },
        ],
      },
    ],
  },
  {
    name: 'Turkiye',
    code: 'TUR',
    regions: [
      {
        name: 'Istanbul',
        code: 'TR-34',
        cities: [
          {
            name: 'Istanbul',
            lat: 41.0082,
            lng: 28.9784,
            population: 15_520_000,
            baseRatePerSqm: 0.73,
          },
        ],
      },
    ],
  },
  {
    name: 'United Arab Emirates',
    code: 'ARE',
    regions: [
      {
        name: 'Dubai',
        code: 'AE-DU',
        cities: [
          {
            name: 'Dubai',
            lat: 25.2048,
            lng: 55.2708,
            population: 3_600_000,
            baseRatePerSqm: 1.14,
          },
        ],
      },
    ],
  },
  {
    name: 'Australia',
    code: 'AUS',
    regions: [
      {
        name: 'New South Wales',
        code: 'AU-NSW',
        cities: [
          {
            name: 'Sydney',
            lat: -33.8688,
            lng: 151.2093,
            population: 5_450_000,
            baseRatePerSqm: 1.3,
          },
        ],
      },
      {
        name: 'Victoria',
        code: 'AU-VIC',
        cities: [
          {
            name: 'Melbourne',
            lat: -37.8136,
            lng: 144.9631,
            population: 5_030_000,
            baseRatePerSqm: 1.12,
          },
        ],
      },
    ],
  },
  {
    name: 'New Zealand',
    code: 'NZL',
    regions: [
      {
        name: 'Auckland',
        code: 'NZ-AUK',
        cities: [
          {
            name: 'Auckland',
            lat: -36.8485,
            lng: 174.7633,
            population: 1_660_000,
            baseRatePerSqm: 0.87,
          },
        ],
      },
    ],
  },
];
