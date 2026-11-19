(module
 (type $E (struct (field anyref) (field (mut anyref)) (field (mut i32)) (field (mut i32)) (field (mut anyref)) (field (mut anyref))))
 (type $M (array (mut (ref null $E))))
 (rec (type $O (struct (field (mut (ref null $O))) (field (mut (ref null $M))) (field (mut i32)) (field (mut i32)) (field (mut i32)) (field (mut i32)) (field (mut anyref)))))
 (func (export "make") (result externref)
  (extern.convert_any (struct.new $O (ref.null $O) (array.new_default $M (i32.const 0)) (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0) (ref.null any)))))
