import type { PlaceStyle } from '../engine/types';

/** What a liked thing says about the kind of place a Will would love to have nearby. */
export const PLACE_HINT: [RegExp, PlaceStyle][] = [
  [/노래|노래방|음악|기타|트로트|애니송/, 'karaoke'],
  [/커피|카페|라떼|재즈/, 'cafe'],
  [/책|도서관|소설|공부/, 'library'],
  [/산책|공원|벤치|나무/, 'park'],
  [/간식|과자|편의점|라면|야식/, 'store'],
  [/빵|크루아상|베이킹|디저트/, 'bakery'],
  [/요리|맛집|김치찌개|국밥|파스타|먹방/, 'restaurant'],
  [/운동|헬스|러닝|요가|근육|체력/, 'gym'],
  [/영화|팝콘|드라마|애니메이션/, 'cinema'],
  [/맥주|술|와인|칵테일|포차/, 'bar'],
  [/꽃|화분|다육이|꽃꽂이/, 'flower'],
  [/공부|수업|선생님|학생|시험/, 'school'],
];
